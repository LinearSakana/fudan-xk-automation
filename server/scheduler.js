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
      courseStates: new Map(),
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
    const courses = this._snapshotCourses();
    return {
      running: this.state.running,
      rps: this.state.rps,
      workers: activeWorkers,
      courses,
    };
  }

  async start(payload = {}) {
    this._validatePayload(payload);

    await this.stop();

    const courses = this._normalizeCourses(payload.courses);
    const concurrency = Number(payload.concurrency || DEFAULT_CONCURRENCY);
    const courseStates = new Map(
      courses.map((course) => [
        course.lessonAssoc,
        {
          lessonAssoc: course.lessonAssoc,
          status: course.isPaused ? 'paused' : 'running',
          success: false,
          markedForRemoval: false,
          activeWorkers: 0,
          workerSeq: 0,
        },
      ]),
    );

    this._job = {
      studentId: String(payload.studentId),
      turnId: String(payload.turnId),
      headers: this._normalizeHeaders(payload.headers, payload.cookie),
      courses: courses.map((course) => course.lessonAssoc),
      concurrency,
      skipCaptcha: Boolean(payload.skipCaptcha),
      abortController: new AbortController(),
      courseStates,
    };

    this.state.running = true;
    this.state.courses = courses.map((course) => course.lessonAssoc);
    this.state.courseStates = courseStates;
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
    const removedCourses = this._collectMarkedForRemovalCourses();
    if (!this.state.running && !this._job) {
      this._resetRuntimeState();
      return { removedCourses };
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
    this._requestTimestamps = [];
    this.state.workers = [];
    this.state.courses = [];
    this.state.courseStates = new Map();
    this.state.rps = 0;

    this.logger.info('scheduler stopped');
    return { removedCourses };
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
      ids.push({
        lessonAssoc,
        isPaused: Boolean(typeof item === 'object' && item !== null && item.isPaused),
      });
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
      const courseState = job.courseStates.get(lessonAssoc);
      if (!courseState || courseState.status !== 'running') continue;
      this._spawnWorkersForCourse(job, lessonAssoc, job.concurrency);
    }
  }

  _spawnWorkersForCourse(job, lessonAssoc, count) {
    const courseState = job.courseStates.get(lessonAssoc);
    if (!courseState || courseState.success || courseState.status !== 'running') {
      return;
    }

    for (let i = 0; i < count; i += 1) {
      const worker = {
        id: `${lessonAssoc}-${courseState.workerSeq}`,
        lessonAssoc,
        active: true,
        counted: true,
      };
      courseState.workerSeq += 1;
      courseState.activeWorkers += 1;

      this.state.workers.push(worker);
      const runPromise = this._runWorker(job, worker)
        .catch((error) => {
          if (this._isAbortError(error)) return;
          this.logger.warn({ err: error, workerId: worker.id }, 'worker terminated with error');
        })
        .finally(() => {
          this._onWorkerExit(worker);
        });
      this._workerPromises.push(runPromise);
    }
  }

  async _runWorker(job, worker) {
    while (this.state.running && worker.active) {
      const courseState = job.courseStates.get(worker.lessonAssoc);
      if (!courseState || courseState.success || courseState.status !== 'running') {
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
          const permitted = await this._waitForCaptchaPermit(worker.id, worker.lessonAssoc);
          if (
            !permitted ||
            !this.state.running ||
            job.abortController.signal.aborted ||
            !worker.active ||
            courseState.success ||
            courseState.status !== 'running'
          ) {
            break;
          }
        }

        const success = await this._requestAddDropResponse(job, addReqData);
        if (success) {
          courseState.success = true;
          courseState.status = 'success';
          courseState.markedForRemoval = true;
          this._deactivateWorkersOfCourse(worker.lessonAssoc);
          this._resolveCaptchaWaitersByCourse(worker.lessonAssoc, false);
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
    const courseState = this._job?.courseStates?.get(lessonAssoc);
    for (const worker of this.state.workers) {
      if (worker.lessonAssoc === lessonAssoc) {
        if (worker.active && worker.counted && courseState) {
          courseState.activeWorkers = Math.max(0, courseState.activeWorkers - 1);
          worker.counted = false;
        }
        worker.active = false;
      }
    }
  }

  _onWorkerExit(worker) {
    const courseState = this._job?.courseStates?.get(worker.lessonAssoc);
    if (courseState && worker.counted) {
      courseState.activeWorkers = Math.max(0, courseState.activeWorkers - 1);
      worker.counted = false;
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

  _waitForCaptchaPermit(workerId, lessonAssoc) {
    if (!this.state.running) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this._captchaWaiters.push({ workerId, lessonAssoc, resolve });
    });
  }

  _grantOneCaptchaPermit() {
    if (!this._captchaWaiters.length) return;
    const waiter = this._captchaWaiters.shift();
    waiter.resolve(true);
  }

  _resolveCaptchaWaitersByCourse(lessonAssoc, value) {
    if (!this._captchaWaiters.length) return;
    const remaining = [];
    for (const waiter of this._captchaWaiters) {
      if (waiter.lessonAssoc === lessonAssoc) {
        waiter.resolve(value);
      } else {
        remaining.push(waiter);
      }
    }
    this._captchaWaiters = remaining;
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
      courseStates: new Map(),
      rps: 0,
    };
  }

  _snapshotCourses() {
    const states = this.state.courseStates || new Map();
    return this.state.courses.map((lessonAssoc) => {
      const state = states.get(lessonAssoc) || null;
      return {
        lessonAssoc,
        status: state?.status || 'pending',
        workers: state?.activeWorkers || 0,
        markedForRemoval: Boolean(state?.markedForRemoval),
      };
    });
  }

  _collectMarkedForRemovalCourses() {
    if (!this._job?.courseStates) return [];
    const removed = [];
    for (const [lessonAssoc, state] of this._job.courseStates.entries()) {
      if (state?.markedForRemoval) {
        removed.push(Number(lessonAssoc));
      }
    }
    return removed;
  }

  _assertRunnableJob() {
    if (!this.state.running || !this._job) {
      const error = new Error('scheduler is not running');
      error.statusCode = 409;
      throw error;
    }
  }

  pauseCourse(lessonAssocInput) {
    this._assertRunnableJob();
    const lessonAssoc = this._normalizeLessonAssocForControl(lessonAssocInput);
    const courseState = this._job.courseStates.get(lessonAssoc);
    if (!courseState) {
      throw this._badRequest(`unknown lessonAssoc: ${lessonAssoc}`);
    }

    if (courseState.status === 'success') {
      return this.getState();
    }

    courseState.status = 'paused';
    this._deactivateWorkersOfCourse(lessonAssoc);
    this._resolveCaptchaWaitersByCourse(lessonAssoc, false);
    return this.getState();
  }

  resumeCourse(lessonAssocInput) {
    this._assertRunnableJob();
    const lessonAssoc = this._normalizeLessonAssocForControl(lessonAssocInput);
    const courseState = this._job.courseStates.get(lessonAssoc);
    if (!courseState) {
      throw this._badRequest(`unknown lessonAssoc: ${lessonAssoc}`);
    }
    if (courseState.status === 'success') {
      return this.getState();
    }
    if (courseState.status === 'running' && courseState.activeWorkers > 0) {
      return this.getState();
    }

    courseState.status = 'running';
    this._spawnWorkersForCourse(this._job, lessonAssoc, this._job.concurrency);
    return this.getState();
  }

  _normalizeLessonAssocForControl(raw) {
    const num = Number(raw);
    const lessonAssoc = Math.trunc(num);
    if (!Number.isFinite(num) || lessonAssoc <= 0) {
      throw this._badRequest('lessonAssoc must be a positive integer');
    }
    return lessonAssoc;
  }

  _isAbortError(error) {
    return error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
  }
}

module.exports = {
  Scheduler,
};
