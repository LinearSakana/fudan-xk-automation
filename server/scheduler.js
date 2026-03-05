'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { Agent, fetch } = require('undici');
const { CaptchaEngine } = require('./captcha');

const DEFAULT_BASE_URL = 'https://xk.fudan.edu.cn';
const DEFAULT_CONCURRENCY = 2;
const CAPTURE_WINDOW_MS = 1000;
const NEGLECT_CAPTCHA_VERIFICATION_RESPONSE = true;
const CAPTCHA_LOOP_INTERVAL_MS = 5;

class Scheduler {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.captchaRecordsPath = options.captchaRecordsPath || '';

    this.agent = new Agent({
      keepAliveTimeout: 10,
      keepAliveMaxTimeout: 10,
      connections: Number(process.env.XK_MAX_CONNECTIONS || 256),
      pipelining: 1,
    });

    this.captcha = new CaptchaEngine({
      logger: this.logger,
      captchaRecordsUrl: process.env.CAPTCHA_RECORDS_URL,
    });

    this.state = {
      running: false,
      workers: [],
      courses: [],
      rps: 0,
    };

    this._job = null;
    this._requestTimestamps = [];
    this._rpsTimer = null;
    this._captchaWaiters = [];
    this._captchaLoopPromise = null;
    this._workerPromises = [];
  }

  getState() {
    const activeWorkers = this.state.workers.filter((worker) => worker.active).length;
    return {
      running: this.state.running,
      rps: this.state.rps,
      workers: activeWorkers,
    };
  }

  async start(payload = {}) {
    this._validatePayload(payload);

    await this.stop();

    const courses = this._normalizeCourses(payload.courses);
    const concurrency = Number(payload.concurrency || DEFAULT_CONCURRENCY);

    this._job = {
      studentId: String(payload.studentId),
      turnId: String(payload.turnId),
      headers: this._normalizeHeaders(payload.headers, payload.cookie),
      courses,
      concurrency,
      skipCaptcha: Boolean(payload.skipCaptcha),
      abortController: new AbortController(),
      courseStates: new Map(courses.map((courseId) => [courseId, { success: false }])),
    };

    this.state.running = true;
    this.state.courses = [...courses];
    this.state.rps = 0;
    this._requestTimestamps = [];
    this._captchaWaiters = [];

    try {
      this._startRpsMeter();

      if (!this._job.skipCaptcha) {
        try {
          await this.captcha.loadRecords(this.captchaRecordsPath);
        } catch (error) {
          if (!this.captcha.hasRecords()) {
            throw new Error(`captcha records unavailable: ${error.message}`);
          }
          this.logger.warn({ err: error }, 'failed to refresh captcha records, fallback to cached records');
        }

        this._captchaLoopPromise = this.captcha
          .captchaLoop({
            studentId: this._job.studentId,
            turnId: this._job.turnId,
            request: (method, path, body) => this._apiRequest(this._job, method, path, body),
            isRunning: () => this.state.running && !this._job?.abortController.signal.aborted,
            onVerified: () => this._grantOneCaptchaPermit(),
            onIterationError: (error) => {
              if (!this._isAbortError(error)) {
                this.logger.debug({ err: error }, 'captcha loop iteration failed');
              }
            },
            intervalMs: CAPTCHA_LOOP_INTERVAL_MS,
            neglectVerificationResponse: NEGLECT_CAPTCHA_VERIFICATION_RESPONSE,
          })
          .catch((error) => {
            this.logger.error({ err: error }, 'captcha loop crashed');
          });
      }

      this._spawnWorkers(this._job);

      this.logger.info(
        {
          courseCount: courses.length,
          concurrency,
          workerCount: this.state.workers.length,
          skipCaptcha: this._job.skipCaptcha,
        },
        'scheduler started',
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.state.running && !this._job) {
      this._resetRuntimeState();
      return;
    }

    this.state.running = false;

    if (this._job?.abortController) {
      this._job.abortController.abort();
    }

    this._resolveAllCaptchaWaiters();

    if (this._captchaLoopPromise) {
      await Promise.race([this._captchaLoopPromise, sleep(300)]);
    }

    this._stopRpsMeter();

    this.state.workers.forEach((worker) => {
      worker.active = false;
    });
    if (this._workerPromises.length) {
      await Promise.race([Promise.allSettled(this._workerPromises), sleep(500)]);
    }

    this._job = null;
    this._captchaLoopPromise = null;
    this._workerPromises = [];
    this._captchaWaiters = [];
    this.state.rps = 0;

    this.logger.info('scheduler stopped');
  }

  _validatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw this._badRequest('payload is required');
    }

    if (!payload.studentId) throw this._badRequest('studentId is required');
    if (!payload.turnId) throw this._badRequest('turnId is required');
    if (!payload.cookie) throw this._badRequest('cookie is required');
    if (!Array.isArray(payload.courses) || payload.courses.length === 0) {
      throw this._badRequest('courses must be a non-empty array');
    }

    const concurrency = Number(payload.concurrency || DEFAULT_CONCURRENCY);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 30) {
      throw this._badRequest('concurrency must be an integer in [1, 30]');
    }
  }

  _badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  }

  _normalizeCourses(courses) {
    const ids = [];
    const seen = new Set();

    for (const item of courses) {
      const raw = typeof item === 'object' && item !== null ? item.lessonAssoc : item;
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) continue;

      const lessonAssoc = Math.trunc(numeric);
      if (lessonAssoc <= 0) continue;
      if (seen.has(lessonAssoc)) continue;

      seen.add(lessonAssoc);
      ids.push(lessonAssoc);
    }

    if (ids.length === 0) {
      throw this._badRequest('courses has no valid lessonAssoc');
    }

    return ids;
  }

  _normalizeHeaders(capturedHeaders, cookie) {
    const headers = {};

    if (capturedHeaders && typeof capturedHeaders === 'object') {
      for (const [key, value] of Object.entries(capturedHeaders)) {
        if (value === undefined || value === null) continue;
        headers[String(key)] = String(value);
      }
    }

    headers.cookie = String(cookie);

    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
    }

    return headers;
  }

  _spawnWorkers(job) {
    this.state.workers = [];
    this._workerPromises = [];

    for (const lessonAssoc of job.courses) {
      for (let i = 0; i < job.concurrency; i += 1) {
        const worker = {
          id: `${lessonAssoc}-${i}`,
          lessonAssoc,
          active: true,
        };

        this.state.workers.push(worker);
        const runPromise = this._runWorker(job, worker).catch((error) => {
          if (this._isAbortError(error)) return;
          this.logger.warn({ err: error, workerId: worker.id }, 'worker terminated with error');
        });
        this._workerPromises.push(runPromise);
      }
    }
  }

  async _runWorker(job, worker) {
    while (this.state.running && worker.active) {
      const courseState = job.courseStates.get(worker.lessonAssoc);
      if (!courseState || courseState.success) {
        worker.active = false;
        break;
      }

      try {
        const predicateData = await this._requestAddPredicate(job, worker.lessonAssoc);
        if (!predicateData) continue;

        this._requestPredicateResponse(job, predicateData).catch((error) => {
          if (!this._isAbortError(error)) {
            this.logger.debug({ err: error, workerId: worker.id }, 'predicate-response failed');
          }
        });

        const addReqData = await this._requestAddRequest(job, worker.lessonAssoc);
        if (!addReqData) continue;

        if (!job.skipCaptcha) {
          const permitted = await this._waitForCaptchaPermit(worker.id);
          if (
            !permitted ||
            !this.state.running ||
            job.abortController.signal.aborted ||
            !worker.active ||
            courseState.success
          ) {
            break;
          }
        }

        const success = await this._requestAddDropResponse(job, addReqData);
        if (success) {
          courseState.success = true;
          this._deactivateWorkersOfCourse(worker.lessonAssoc);
          this.logger.info({ lessonAssoc: worker.lessonAssoc }, 'course grab success');
          break;
        }
      } catch (error) {
        if (this._isAbortError(error)) break;
        this.logger.debug({ err: error, workerId: worker.id }, 'worker iteration failed');
      }
    }

    worker.active = false;
  }

  _deactivateWorkersOfCourse(lessonAssoc) {
    for (const worker of this.state.workers) {
      if (worker.lessonAssoc === lessonAssoc) {
        worker.active = false;
      }
    }
  }

  async _requestAddPredicate(job, lessonAssoc) {
    const payload = {
      studentAssoc: Number(job.studentId),
      courseSelectTurnAssoc: Number(job.turnId),
      requestMiddleDtos: [{ lessonAssoc, virtualCost: 0 }],
      coursePackAssoc: null,
    };

    const parsed = await this._apiRequest(job, 'POST', '/api/v1/student/course-select/add-predicate', payload);
    if (parsed?.result !== 0 || !parsed?.data) return null;
    return parsed.data;
  }

  async _requestPredicateResponse(job, predicateData) {
    const path = `/api/v1/student/course-select/predicate-response/${job.studentId}/${predicateData}`;
    return this._apiRequest(job, 'GET', path);
  }

  async _requestAddRequest(job, lessonAssoc) {
    const payload = {
      studentAssoc: Number(job.studentId),
      courseSelectTurnAssoc: Number(job.turnId),
      requestMiddleDtos: [{ lessonAssoc, virtualCost: null }],
      coursePackAssoc: null,
    };

    const parsed = await this._apiRequest(job, 'POST', '/api/v1/student/course-select/add-request', payload);
    if (parsed?.result !== 0 || !parsed?.data) return null;
    return parsed.data;
  }

  async _requestAddDropResponse(job, addReqData) {
    const path = `/api/v1/student/course-select/add-drop-response/${job.studentId}/${addReqData}`;
    const parsed = await this._apiRequest(job, 'GET', path);
    return Boolean(parsed?.data?.success);
  }

  _waitForCaptchaPermit(workerId) {
    if (!this.state.running) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this._captchaWaiters.push({ workerId, resolve });
    });
  }

  _grantOneCaptchaPermit() {
    if (!this._captchaWaiters.length) return;
    const waiter = this._captchaWaiters.shift();
    waiter.resolve(true);
  }

  _resolveAllCaptchaWaiters() {
    while (this._captchaWaiters.length) {
      const waiter = this._captchaWaiters.shift();
      waiter.resolve(false);
    }
  }

  async _apiRequest(job, method, path, body) {
    const url = new URL(path, this.baseUrl).toString();
    const headers = { ...job.headers };

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher: this.agent,
      signal: job.abortController.signal,
    });

    const text = await response.text();
    this._trackRequest();

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} for ${path}`);
      error.statusCode = response.status;
      error.responseBody = text;
      throw error;
    }

    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (error) {
      const parseError = new Error(`invalid JSON response for ${path}`);
      parseError.cause = error;
      parseError.responseBody = text;
      throw parseError;
    }
  }

  _trackRequest() {
    const now = Date.now();
    this._requestTimestamps.push(now);

    const min = now - CAPTURE_WINDOW_MS;
    while (this._requestTimestamps.length > 0 && this._requestTimestamps[0] < min) {
      this._requestTimestamps.shift();
    }
  }

  _startRpsMeter() {
    this._stopRpsMeter();
    this._rpsTimer = setInterval(() => {
      const now = Date.now();
      const min = now - CAPTURE_WINDOW_MS;
      while (this._requestTimestamps.length > 0 && this._requestTimestamps[0] < min) {
        this._requestTimestamps.shift();
      }
      this.state.rps = this._requestTimestamps.length;
    }, 1000);
  }

  _stopRpsMeter() {
    if (this._rpsTimer) {
      clearInterval(this._rpsTimer);
      this._rpsTimer = null;
    }
  }

  _resetRuntimeState() {
    this._stopRpsMeter();
    this._job = null;
    this._captchaWaiters = [];
    this._captchaLoopPromise = null;
    this._workerPromises = [];
    this._requestTimestamps = [];
    this.state = {
      running: false,
      workers: [],
      courses: [],
      rps: 0,
    };
  }

  _isAbortError(error) {
    return error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
  }
}

module.exports = {
  Scheduler,
};
