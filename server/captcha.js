'use strict';

const { readFile, readdir, stat } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { fetch } = require('undici');

const LIST_OF_IMGINDEX = [
  '3ab5eec0-fbb6-4c3f-bfcc-0ce693077db3',
  '393c5000-304d-4d2d-9ce1-3db6345e0a6b',
  '3437e4cb-a995-4fae-aeea-14174abc0d6a',
  '60176ec4-7482-4763-876a-431eceefe779',
  'c6e7c8e9-b681-4dc2-8d61-e45588f8c7fa',
  'c9f5d967-9c4b-43fe-b2eb-dc0a2ef01ed7',
];
const DEFAULT_CAPTCHA_RECORDS_URL =
  'https://tempfile.char.moe/course-grabber/FudanCourseGrabber/captchaRecords/';

class CaptchaEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.fetchImpl = options.fetchImpl || fetch;
    const baseUrl = options.captchaRecordsUrl || DEFAULT_CAPTCHA_RECORDS_URL;
    this.captchaRecordsUrl = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
    this.captchaMap = new Map();
  }

  async loadRecords(inputPath) {
    const loaded = new Map();

    if (inputPath) {
      await this._loadFromPath(inputPath, loaded);
    } else {
      await this._loadFromRemote(loaded);
    }

    if (loaded.size === 0) {
      throw new Error('captcha records not loaded');
    }

    this.captchaMap = loaded;

    const totalEntries = Array.from(loaded.values()).reduce((sum, map) => sum + map.size, 0);
    this.logger.info(
      {
        imgCount: loaded.size,
        totalEntries,
      },
      'captcha records loaded',
    );
  }

  solve(imgIndex, posIndex) {
    const posMap = this.captchaMap.get(String(imgIndex));
    if (!posMap) return null;

    const value = posMap.get(String(posIndex));
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  hasRecords() {
    return this.captchaMap.size > 0;
  }

  async captchaLoop(options = {}) {
    const {
      studentId,
      turnId,
      request,
      isRunning,
      onVerified,
      onIterationError,
      intervalMs = 5,
      neglectVerificationResponse = true,
    } = options;

    if (!studentId || !turnId) {
      throw new Error('studentId and turnId are required for captcha loop');
    }
    if (typeof request !== 'function') {
      throw new Error('captcha loop request function is required');
    }
    if (typeof isRunning !== 'function') {
      throw new Error('captcha loop isRunning function is required');
    }

    let isCaptchaRequestInFlight = false;

    while (isRunning()) {
      if (isCaptchaRequestInFlight) {
        await sleep(intervalMs);
        continue;
      }

      isCaptchaRequestInFlight = true;
      try {
        const randomImgPath = `/api/v1/student/course-select/getRandomImg?studentId=${encodeURIComponent(
          String(studentId),
        )}&turnId=${encodeURIComponent(String(turnId))}`;

        const randomParsed = await request('GET', randomImgPath);
        if (randomParsed?.result !== 0 || !randomParsed?.data) {
          await sleep(intervalMs);
          continue;
        }

        const { imgIndex, posIndex } = randomParsed.data;
        const moveEndX = this.solve(imgIndex, posIndex);

        if (moveEndX === null) {
          this.logger.debug({ imgIndex, posIndex }, 'captcha mapping not found');
          await sleep(intervalMs);
          continue;
        }

        const rstImgPath = `/api/v1/student/course-select/rstImgSwipe?moveEndX=${encodeURIComponent(
          moveEndX,
        )}&wbili=1&studentId=${encodeURIComponent(String(studentId))}&turnId=${encodeURIComponent(String(turnId))}`;

        if (neglectVerificationResponse) {
          request('GET', rstImgPath).catch((error) => {
            if (typeof onIterationError === 'function') {
              onIterationError(error);
            }
          });
          if (typeof onVerified === 'function') {
            onVerified({ imgIndex, posIndex, moveEndX });
          }
          await sleep(intervalMs);
          continue;
        }

        const rstParsed = await request('GET', rstImgPath);
        const verified = rstParsed?.success === true || rstParsed?.data?.success === true;
        if (verified && typeof onVerified === 'function') {
          onVerified({ imgIndex, posIndex, moveEndX });
        }
      } catch (error) {
        if (typeof onIterationError === 'function') {
          onIterationError(error);
        } else {
          throw error;
        }
      } finally {
        isCaptchaRequestInFlight = false;
      }
    }
  }

  async _loadFromPath(inputPath, target) {
    const absPath = path.resolve(inputPath);
    const st = await stat(absPath);

    if (st.isDirectory()) {
      const fileNames = await readdir(absPath);
      const jsonFiles = fileNames.filter((name) => name.toLowerCase().endsWith('.json'));

      for (const fileName of jsonFiles) {
        const filePath = path.join(absPath, fileName);
        const imgIndex = path.basename(fileName, '.json');
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        target.set(String(imgIndex), this._normalizePosMap(parsed));
      }

      if (target.size === 0) {
        throw new Error(`no json files found in directory: ${absPath}`);
      }
      return;
    }

    const parsed = JSON.parse(await readFile(absPath, 'utf8'));

    // Compatible with aggregated format: { imgIndex: { posIndex: moveEndX } }
    if (this._isObject(parsed) && Object.values(parsed).every((entry) => this._isObject(entry))) {
      for (const [imgIndex, posMap] of Object.entries(parsed)) {
        target.set(String(imgIndex), this._normalizePosMap(posMap));
      }
      return;
    }

    // Compatible with single-file format: { posIndex: moveEndX }
    const imgIndex = path.basename(absPath, '.json');
    target.set(String(imgIndex), this._normalizePosMap(parsed));
  }

  async _loadFromRemote(target) {
    const tasks = LIST_OF_IMGINDEX.map(async (imgIndex) => {
      const url = `${this.captchaRecordsUrl}${imgIndex}.json`;
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        throw new Error(`failed to fetch captcha record ${imgIndex}: HTTP ${response.status}`);
      }

      const parsed = await response.json();
      target.set(imgIndex, this._normalizePosMap(parsed));
    });

    await Promise.all(tasks);
  }

  _normalizePosMap(raw) {
    if (!this._isObject(raw)) {
      throw new Error('captcha pos map must be an object');
    }

    const normalized = new Map();
    for (const [posIndex, moveEndX] of Object.entries(raw)) {
      const numeric = Number(moveEndX);
      if (!Number.isFinite(numeric)) continue;
      normalized.set(String(posIndex), numeric);
    }
    return normalized;
  }

  _isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
}

module.exports = {
  CaptchaEngine,
  LIST_OF_IMGINDEX,
  DEFAULT_CAPTCHA_RECORDS_URL,
};
