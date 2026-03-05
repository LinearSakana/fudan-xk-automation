// ==UserScript==
// @name         复旦选课助手
// @namespace    https://github.com/LinearSakana/fudan-xk-grabber
// @version      0.1.0
// @description  复旦大学本科生选课助手，使用前请确保已启动本地 Server
// @author       LinearSakana
// @match        *://xk.fudan.edu.cn/*
// @icon         https://id.fudan.edu.cn/ac/favicon.ico
// @grant        none
// @run-at       document-start
// @updateURL    https://github.com/LinearSakana/fudan-xk-automation/raw/main/userscript/course-grabber.user.js
// @downloadURL  https://github.com/LinearSakana/fudan-xk-automation/raw/main/userscript/course-grabber.user.js
// ==/UserScript==

(function () {
    'use strict';

    // --- 全局配置 ---
    const SERVER_BASE_URL = 'http://127.0.0.1:30522';
    const STORAGE_KEY = 'fudan_course_grabber_state';
    const STATE = {
        courses: [], // 意向课程列表 { lessonAssoc: number, status: 'pending' | 'success', isPaused?: boolean, courseName?: string, teacherNames?: string[], schedule?: object[] }
        studentId: '',
        turnId: '',
        semesterId: '505',
        headers: {}, // 从原始请求中捕获的全局 HTTP 头
        isGrabbing: false,
        skipCaptcha: false, // 是否跳过验证码
        isImporting: false,
        concurrency: 2, // 每门课并发实例数量
        rps: 0,
        workers: 0,
        statusIntervalId: null,
        toBeRemoved: new Set(),
        serverErrorNoticeKey: '',
    };
    const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, (ch) => {
            const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'};
            return map[ch] || ch;
        });
    }

    function uniqueNonEmpty(items) {
        const seen = new Set();
        const result = [];
        (items || []).forEach(item => {
            if (!item && item !== 0) return;
            const key = String(item).trim();
            if (!key || seen.has(key)) return;
            seen.add(key);
            result.push(key);
        });
        return result;
    }

    function normalizeConcurrency(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 2;
        return Math.min(10, Math.max(1, Math.trunc(num)));
    }

    function normalizeLessonAssoc(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        const lessonAssoc = Math.trunc(num);
        return lessonAssoc > 0 ? lessonAssoc : null;
    }

    function getCoursePayloadForServer() {
        const seen = new Set();
        const courses = [];
        STATE.courses.forEach((course) => {
            const lessonAssoc = normalizeLessonAssoc(course.lessonAssoc);
            if (lessonAssoc === null || seen.has(lessonAssoc)) return;
            seen.add(lessonAssoc);
            courses.push({
                lessonAssoc,
                isPaused: Boolean(course.isPaused),
            });
        });
        return courses;
    }

    async function requestLocalApi(path, method = 'GET', payload = null) {
        const response = await fetch(`${SERVER_BASE_URL}${path}`, {
            method,
            headers: {'Content-Type': 'application/json'},
            body: payload ? JSON.stringify(payload) : undefined,
        });
        const parsed = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parsed.error || `HTTP ${response.status}`);
        }
        return parsed;
    }

    // --- UI 模块 ---
    const UI = {
        panel: null,
        courseListEl: null,
        hoverCardEl: null,
        hoverCourseIndex: -1,
        lastRenderState: null,
        lastButtonsState: null,
        createPanel() {
            if (document.getElementById('grabber-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'grabber-panel';
            panel.innerHTML = `
                <div class="grabber-header">
                    <span class="grabber-title">选课助手</span>
                    <span id="header-student-id" class="header-student-id" title="StudentID" style="display: none;"></span>
                </div>
                <div class="grabber-body">
                    <div class="grabber-controls">
                        <label class="checkbox-label" title="跳过滑动验证码（按需设置）">
                            <input type="checkbox" id="skip-captcha-checkbox">
                            <span class="checkmark"></span>
                            跳过验证
                        </label>
                        <div class="rps-display" title="本地服务状态">
                            RPS: <span id="rps-value">0</span> | Workers: <span id="workers-value">0</span>
                        </div>
                    </div>
                    <div class="grabber-slider-group">
                        <label for="concurrency-slider" id="concurrency-num">并发数</label>
                        <input type="range" id="concurrency-slider" min="1" max="10" value="2">
                        <span id="concurrency-value" class="badge">2</span>
                    </div>
                    <ul id="course-list"></ul>
                    <div class="grabber-sub-actions">
                        <button id="import-btn" class="btn-secondary" title="从页面自动捕获课程">导入页面</button>
                        <button id="reset-btn" class="btn-secondary" title="清除学号等上下文">重置状态</button>
                        <button id="clear-btn" class="btn-secondary danger" title="清空全部意向课程">清空列表</button>
                    </div>
                    <div class="grabber-actions">
                        <button id="grab-btn" class="btn-start">开始抢课</button>
                    </div>
                </div>
            `;
            document.body.appendChild(panel);
            this.panel = panel;
            this.courseListEl = document.getElementById('course-list');
            this.ensureHoverCard();
            this.applyStyles();
            this.makeDraggable(panel, panel.querySelector('.grabber-header'));
            this.addEventListeners();
        },
        ensureHoverCard() {
            if (this.hoverCardEl) return;
            const hoverCard = document.createElement('div');
            hoverCard.id = 'course-hover-card';
            hoverCard.className = 'course-hover-card';
            document.body.appendChild(hoverCard);
            this.hoverCardEl = hoverCard;
        },
        applyStyles() {
            const styles = `
                #grabber-panel { position: fixed; top: 80px; right: 20px; width: 320px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 16px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.05); z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; overflow: hidden; transition: box-shadow 0.3s ease; display: flex; flex-direction: column; }
                .grabber-header { padding: 8px 16px; background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%); color: white; display: flex; align-items: center; justify-content: space-between; cursor: move; user-select: none; }
                .grabber-title { font-weight: 400; font-size: 14px; letter-spacing: 0.5px; }
                .header-student-id { font-size: 12px; opacity: 0.9; background: rgba(255,255,255,0.2); padding: 2px 8px; border-radius: 12px; font-variant-numeric: tabular-nums; }
                .grabber-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
                .grabber-controls { display: flex; justify-content: space-between; align-items: center; }
                .checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: #4a5568; user-select: none; }
                .checkbox-label input { display: none; }
                .checkmark { width: 16px; height: 16px; border: 2px solid #cbd5e0; border-radius: 4px; display: inline-block; position: relative; transition: all 0.2s; }
                .checkbox-label input:checked + .checkmark { background: #3182ce; border-color: #3182ce; }
                .checkbox-label input:checked + .checkmark::after { content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
                .rps-display { font-size: 13px; color: #4a5568; background: #edf2f7; padding: 4px 10px; border-radius: 12px; font-weight: 500; }
                #rps-value { color: #2b6cb0; font-variant-numeric: tabular-nums; }
                .grabber-slider-group { display: flex; align-items: center; gap: 10px; padding: 6px 8px }
                #concurrency-num { font-size: 13px; color: #4a5568; white-space: nowrap; }
                #concurrency-slider { flex-grow: 1; accent-color: #3182ce; height: 6px; border-radius: 2px; }
                .badge { background: #e2e8f0; color: #2d3748; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; min-width: 24px; text-align: center; }
                #course-list { list-style: none; padding: 0; margin: 0; max-height: 380px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; scrollbar-color: #cbd5e0 transparent; }
                #course-list::-webkit-scrollbar { width: 6px; }
                #course-list::-webkit-scrollbar-thumb { background-color: #cbd5e0; border-radius: 10px; }
                #course-list li { display: flex; align-items: center; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #ffffff; transition: all 0.2s ease; }
                #course-list li:hover { transform: translateY(-1px); border-color: #cbd5e0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
                #course-list li.course-paused { background: #f7fafc; opacity: 0.7; }
                .course-main { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
                .course-title { font-weight: 600; color: #2d3748; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .course-teachers { font-size: 11px; color: #718096; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .course-status-pill { width: 14px; height: 14px; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 0 1px #e2e8f0; transition: all 0.2s; padding: 0; }
                .course-status-pill:not(:disabled) { cursor: pointer; }
                .course-status-pill:not(:disabled):hover { transform: scale(1.15); }
                .status-running { background: #4299e1; box-shadow: 0 0 0 1px #4299e1, 0 0 8px rgba(66, 153, 225, 0.4); animation: pulse 2s infinite; }
                .status-success { background: #48bb78; box-shadow: 0 0 0 1px #48bb78; }
                .status-paused { background: #a0aec0; box-shadow: 0 0 0 1px #a0aec0; }
                @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(66, 153, 225, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(66, 153, 225, 0); } 100% { box-shadow: 0 0 0 0 rgba(66, 153, 225, 0); } }
                .course-actions button { background: none; border: none; cursor: pointer; font-size: 14px; color: #e53e3e; opacity: 0.6; transition: all 0.2s; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
                .course-actions button:hover { opacity: 1; background: #fff5f5; }
                .grabber-sub-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .btn-secondary { padding: 6px 0; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; background: #ffffff; color: #4a5568; font-size: 12px; font-weight: 500; transition: all 0.2s; }
                .btn-secondary:hover:not(:disabled) { background: #f7fafc; border-color: #cbd5e0; }
                .btn-secondary.danger:hover:not(:disabled) { background: #fff5f5; color: #e53e3e; border-color: #feb2b2; }
                .btn-start { width: 100%; padding: 12px; font-size: 15px; font-weight: 600; background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); color: white; border: none; border-radius: 10px; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 12px rgba(72, 187, 120, 0.3); }
                .btn-start:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(72, 187, 120, 0.4); }
                .btn-start:active:not(:disabled) { transform: translateY(1px); }
                .btn-start.grabbing { background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%); box-shadow: 0 4px 12px rgba(229, 62, 62, 0.3); }
                .btn-start.grabbing:hover:not(:disabled) { box-shadow: 0 6px 16px rgba(229, 62, 62, 0.4); }
                button:disabled { cursor: not-allowed; opacity: 0.5; filter: grayscale(100%); }
                .course-hover-card { position: fixed; z-index: 10000; width: max-content; max-width: 320px; padding: 14px; border: 1px solid rgba(255,255,255,0.8); border-radius: 12px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px); box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1), 0 4px 10px rgba(0, 0, 0, 0.05); color: #2d3748; font-size: 12px; line-height: 1.5; pointer-events: none; opacity: 0; transform: translateY(8px); transition: opacity 0.15s ease, transform 0.15s ease; }
                .course-hover-card.show { opacity: 1; transform: translateY(0); }
                .hover-title { font-size: 14px; font-weight: 600; color: #1a202c; margin-bottom: 8px; }
                .hover-row { margin-bottom: 4px; display: flex; align-items: baseline; }
                .hover-key { color: #718096; width: 60px; flex-shrink: 0; font-size: 11px; }
                .hover-value { flex-grow: 1; font-weight: 500; }
                .hover-schedule { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e2e8f0; }
                .hover-schedule .hover-key { display: block; margin-bottom: 4px; }
                .hover-schedule-items { color: #4a5568; font-weight: 500; }
            `;
            const styleSheet = document.createElement("style");
            styleSheet.type = "text/css";
            styleSheet.innerText = styles;
            document.head.appendChild(styleSheet);
        },
        formatScheduleDetails(course) {
            if (!Array.isArray(course.scheduleSummary) || course.scheduleSummary.length === 0) {
                return '待获取';
            }
            return course.scheduleSummary.slice(0, 4).map(item => escapeHtml(item)).join('<br>');
        },
        buildCourseHoverCard(course) {
            const courseCode = course.courseCode || course.lessonCode || '待同步';
            const teacherText = (Array.isArray(course.teacherNames) && course.teacherNames.length > 0)
                ? course.teacherNames.join('、')
                : '待获取';
            const creditText = (course.credits === null || course.credits === undefined) ? '待同步' : String(course.credits);
            const campusText = course.campus || '待同步';
            const limitText = (course.limitCount === null || course.limitCount === undefined) ? '待同步' : String(course.limitCount);
            const remarkText = course.selectionRemark || '无';
            return `
                <div class="hover-title">${escapeHtml(course.courseName)}</div>
                <div class="hover-row"><div class="hover-key">课程 ID</div><div class="hover-value">${escapeHtml(course.lessonAssoc)}</div></div>
                <div class="hover-row"><div class="hover-key">代码</div><div class="hover-value">${escapeHtml(courseCode)}</div></div>
                <div class="hover-row"><div class="hover-key">教师</div><div class="hover-value">${escapeHtml(teacherText)}</div></div>
                <div class="hover-row"><div class="hover-key">学分</div><div class="hover-value">${escapeHtml(creditText)}</div></div>
                <div class="hover-row"><div class="hover-key">校区</div><div class="hover-value">${escapeHtml(campusText)}</div></div>
                <div class="hover-row"><div class="hover-key">容量</div><div class="hover-value">${escapeHtml(limitText)}</div></div>
                <div class="hover-row"><div class="hover-key">备注</div><div class="hover-value">${escapeHtml(remarkText)}</div></div>
                <div class="hover-schedule"><div class="hover-key">时间</div><div class="hover-schedule-items">${this.formatScheduleDetails(course)}</div></div>
            `;
        },
        positionHoverCard(clientX, clientY) {
            if (!this.hoverCardEl) return;
            const GAP = 14;
            const rect = this.hoverCardEl.getBoundingClientRect();
            let left = clientX + GAP;
            let top = clientY + GAP;
            if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - GAP;
            if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
            if (left < 8) left = 8;
            if (top < 8) top = 8;
            this.hoverCardEl.style.left = `${left}px`;
            this.hoverCardEl.style.top = `${top}px`;
        },
        showHoverCard(course, index, clientX, clientY) {
            if (!this.hoverCardEl || !course) return;
            if (this.hoverCourseIndex !== index) {
                this.hoverCardEl.innerHTML = this.buildCourseHoverCard(course);
                this.hoverCourseIndex = index;
            }
            this.hoverCardEl.classList.add('show');
            this.positionHoverCard(clientX, clientY);
        },
        hideHoverCard() {
            if (!this.hoverCardEl) return;
            this.hoverCardEl.classList.remove('show');
            this.hoverCourseIndex = -1;
        },
        makeDraggable(element, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = (e) => {
                e.preventDefault();
                pos3 = e.clientX;
                pos4 = e.clientY;
                document.onmouseup = () => {
                    document.onmouseup = null;
                    document.onmousemove = null;
                };
                document.onmousemove = (e) => {
                    e.preventDefault();
                    pos1 = pos3 - e.clientX;
                    pos2 = pos4 - e.clientY;
                    pos3 = e.clientX;
                    pos4 = e.clientY;
                    element.style.top = (element.offsetTop - pos2) + "px";
                    element.style.left = (element.offsetLeft - pos1) + "px";
                };
            };
        },
        render() {
            const studentIdEl = document.getElementById('header-student-id');
            const StudentIdText = STATE.studentId ? STATE.studentId : '未捕获';
            if (studentIdEl && studentIdEl.textContent !== StudentIdText) {
                studentIdEl.textContent = 'ID: ' + StudentIdText;
                studentIdEl.style.display = STATE.studentId ? 'inline-block' : 'none';
            }

            const skipCaptchaEl = document.getElementById('skip-captcha-checkbox');
            if (skipCaptchaEl && skipCaptchaEl.checked !== STATE.skipCaptcha) {
                skipCaptchaEl.checked = STATE.skipCaptcha;
            }

            const concurrencySlider = document.getElementById('concurrency-slider');
            if (concurrencySlider && concurrencySlider.value !== STATE.concurrency.toString()) {
                concurrencySlider.value = STATE.concurrency;
            }

            const concurrencyValue = document.getElementById('concurrency-value');
            if (concurrencyValue && concurrencyValue.textContent !== STATE.concurrency.toString()) {
                concurrencyValue.textContent = STATE.concurrency;
            }

            const rpsText = STATE.rps.toString();
            const rpsEl = document.getElementById('rps-value');
            if (rpsEl && rpsEl.textContent !== rpsText) {
                rpsEl.textContent = rpsText;
            }
            const workersEl = document.getElementById('workers-value');
            const workersText = STATE.workers.toString();
            if (workersEl && workersEl.textContent !== workersText) {
                workersEl.textContent = workersText;
            }

            // --- Course List Memoization ---
            const currentCoursesState = STATE.courses.map(c =>
                `${c.lessonAssoc}|${c.status}|${c.isPaused}|${c.courseName}|${c.teacherNames?.join(',')}`
            ).join(';') + `|isGrabbing:${STATE.isGrabbing}`;

            if (this.lastRenderState !== currentCoursesState) {
                this.lastRenderState = currentCoursesState;
                this.courseListEl.innerHTML = '';

                const fragment = document.createDocumentFragment();
                STATE.courses.forEach((course, index) => {
                    const li = document.createElement('li');
                    li.dataset.index = String(index);
                    if (course.isPaused && STATE.isGrabbing) {
                        li.classList.add('course-paused');
                    }
                    const courseName = course.courseName || `LessonAssoc: ${course.lessonAssoc}`;
                    const teachersText = (course.teacherNames && course.teacherNames.length > 0)
                        ? course.teacherNames.join('、')
                        : '教师信息待获取';

                    let rightContent;
                    if (STATE.isGrabbing) {
                        const statusClass = course.status === 'success' ? 'status-success' : (course.isPaused ? 'status-paused' : 'status-running');
                        const statusText = course.status === 'success' ? '成功' : (course.isPaused ? '已暂停' : '抢课中');
                        const disabledAttr = course.status === 'success' ? 'disabled' : '';
                        rightContent = `<button class="course-status-pill ${statusClass}" data-index="${index}" data-action="toggle-pause" title="${escapeHtml(statusText)}" aria-label="${escapeHtml(statusText)}" ${disabledAttr}></button>`;
                    } else {
                        rightContent = `<div class="course-actions"><button data-index="${index}" data-action="delete" title="删除">✖</button></div>`;
                    }

                    li.innerHTML = `
                        <div class="course-main">
                            <div class="course-title" title="${escapeHtml(courseName)}">${escapeHtml(courseName)}</div>
                            <div class="course-teachers" title="${escapeHtml(teachersText)}">${escapeHtml(teachersText)}</div>
                        </div>
                        ${rightContent}
                    `;
                    fragment.appendChild(li);
                });
                this.courseListEl.appendChild(fragment);
                this.hideHoverCard();
            }

            // --- Buttons Memoization ---
            const currentButtonsState = `${STATE.isGrabbing}|${STATE.isImporting}`;
            if (this.lastButtonsState !== currentButtonsState) {
                this.lastButtonsState = currentButtonsState;
                const grabBtn = document.getElementById('grab-btn');
                const importBtn = document.getElementById('import-btn');
                const resetBtn = document.getElementById('reset-btn');
                const clearBtn = document.getElementById('clear-btn');

                if (STATE.isGrabbing) {
                    grabBtn.textContent = '停止抢课';
                    grabBtn.classList.add('grabbing');
                    importBtn.disabled = true;
                    resetBtn.disabled = true;
                    clearBtn.disabled = true;
                } else {
                    grabBtn.textContent = '开始抢课';
                    grabBtn.classList.remove('grabbing');
                    importBtn.disabled = STATE.isImporting;
                    resetBtn.disabled = false;
                    clearBtn.disabled = false;
                }
                importBtn.textContent = STATE.isImporting ? '正在导入...' : '导入页面';
            }
        },
        addEventListeners() {
            this.courseListEl.addEventListener('click', async (e) => {
                const target = e.target.closest('button');
                if (!target) return;
                const index = parseInt(target.dataset.index, 10);
                if (Number.isNaN(index) || index < 0 || index >= STATE.courses.length) return;
                const course = STATE.courses[index];
                if (!course) return;

                if (STATE.isGrabbing) {
                    if (target.dataset.action !== 'toggle-pause' || course.status === 'success') return;
                    try {
                        await ExecutionEngine.toggleCoursePause(course.lessonAssoc, !course.isPaused);
                    } catch (error) {
                        alert(`课程状态切换失败: ${error.message || error}`);
                    }
                    return;
                }

                if (target.dataset.action === 'delete') {
                    STATE.courses.splice(index, 1);
                    Persistence.save();
                    this.render();
                }
            });
            this.courseListEl.addEventListener('mousemove', (e) => {
                const li = e.target.closest('li[data-index]');
                if (!li || !this.courseListEl.contains(li)) {
                    this.hideHoverCard();
                    return;
                }
                const index = Number(li.dataset.index);
                if (!Number.isInteger(index) || index < 0 || index >= STATE.courses.length) {
                    this.hideHoverCard();
                    return;
                }
                this.showHoverCard(STATE.courses[index], index, e.clientX, e.clientY);
            });
            this.courseListEl.addEventListener('mouseleave', () => {
                this.hideHoverCard();
            });
            this.courseListEl.addEventListener('scroll', () => {
                this.hideHoverCard();
            });
            document.getElementById('grab-btn').addEventListener('click', async () => {
                try {
                    if (STATE.isGrabbing) {
                        await ExecutionEngine.stop();
                    } else {
                        await ExecutionEngine.start();
                    }
                } catch (error) {
                    alert(`请求本地服务失败: ${error.message || error}`);
                }
            });
            document.getElementById('skip-captcha-checkbox').addEventListener('change', (e) => {
                STATE.skipCaptcha = e.target.checked;
                Persistence.save();
            });
            document.getElementById('concurrency-slider').addEventListener('input', (e) => {
                STATE.concurrency = parseInt(e.target.value, 10);
                document.getElementById('concurrency-value').textContent = STATE.concurrency;
                Persistence.save();
            });
            document.getElementById('clear-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                if (confirm('确定要清空所有意向课程吗？')) {
                    STATE.courses = [];
                    Persistence.save();
                    this.render();
                }
            });
            document.getElementById('reset-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                STATE.studentId = '';
                STATE.turnId = '';
                STATE.headers = {};
                STATE.rps = 0;
                STATE.workers = 0;
                Persistence.save();
                this.render();
                console.log('[抢课助手] 上下文信息已重置 ');
            });
            document.getElementById('import-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                STATE.isImporting = true;
                this.render();
                alert('导入模式已开启！请在选课页面进行一次翻页或筛选操作，脚本即自动捕获当前页所有课程 ');
            });
        }
    };

    // --- 数据持久化 ---
    const Persistence = {
        save() {
            const dataToSave = {
                courses: STATE.courses,
                studentId: STATE.studentId,
                turnId: STATE.turnId,
                headers: STATE.headers,
                skipCaptcha: STATE.skipCaptcha,
                concurrency: STATE.concurrency,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
        },
        load() {
            const savedState = localStorage.getItem(STORAGE_KEY);
            if (savedState) {
                const parsed = JSON.parse(savedState);
                STATE.courses = (parsed.courses ?? []).map((course) => {
                    const lessonAssoc = normalizeLessonAssoc(course?.lessonAssoc);
                    if (lessonAssoc === null) return null;
                    return {
                        ...course,
                        lessonAssoc,
                        status: 'pending',
                        isPaused: Boolean(course?.isPaused),
                    };
                }).filter(Boolean);
                STATE.studentId = parsed.studentId ?? '';
                STATE.turnId = parsed.turnId ?? '';
                STATE.headers = parsed.headers ?? {};
                STATE.skipCaptcha = parsed.skipCaptcha ?? false;
                STATE.concurrency = normalizeConcurrency(parsed.concurrency ?? 2);
            }
        }
    };

    // --- XHR 拦截 ---
    const XHRInterceptor = {
        init() {
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (body) {
                let url;
                try {
                    url = new URL(this._url, window.location.origin);
                } catch (_error) {
                    return originalSend.apply(this, arguments);
                }

                // 捕获手动选课操作
                if (url.pathname.includes('/api/v1/student/course-select/add-predicate')) {
                    try {
                        const payload = JSON.parse(body);
                        const lessonAssoc = normalizeLessonAssoc(payload?.requestMiddleDtos?.[0]?.lessonAssoc);
                        const studentAssoc = payload.studentAssoc;
                        const turnId = payload.courseSelectTurnAssoc;
                        if (lessonAssoc === null) {
                            return originalSend.apply(this, arguments);
                        }
                        console.log(`[抢课助手] 捕获到 Lesson ${lessonAssoc}`);
                        if (Object.keys(STATE.headers).length === 0) {
                            STATE.headers = {...this._headers};
                            delete STATE.headers['Host'];
                            delete STATE.headers['Content-Length'];
                            console.log('[抢课助手] 全局 Headers 已捕获:', STATE.headers);
                        }
                        STATE.studentId = studentAssoc.toString();
                        STATE.turnId = turnId.toString();
                        if (!STATE.courses.some(c => c.lessonAssoc === lessonAssoc)) {
                            STATE.courses.push({lessonAssoc, status: 'pending', isPaused: false});
                            ExecutionEngine.syncCourseDetails([lessonAssoc]).catch((error) => {
                                console.warn('[抢课助手] 单课程详情同步失败:', error.message || error);
                            });
                        }
                        Persistence.save();
                        UI.render();
                    } catch (e) {
                        console.error('[抢课助手] 解析请求 payload 失败:', e);
                    }
                }
                // 捕获页面课程列表加载操作（仅在导入模式下）
                else if (STATE.isImporting && url.pathname.includes('/api/v1/student/course-select/std-count')) {
                    const lessonIdsParam = url.searchParams.get('lessonIds');
                    if (lessonIdsParam) {
                        let newCoursesCount = 0;
                        lessonIdsParam.split(',').forEach(idStr => {
                            const lessonAssoc = normalizeLessonAssoc(idStr);
                            if (lessonAssoc !== null && !STATE.courses.some(c => c.lessonAssoc === lessonAssoc)) {
                                STATE.courses.push({lessonAssoc, status: 'pending', isPaused: false});
                                newCoursesCount++;
                            }
                        });
                        console.log(`[抢课助手] 导入 ${newCoursesCount} 门新课程 `);
                        if (newCoursesCount > 0) {
                            ExecutionEngine.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc)).catch((error) => {
                                console.warn('[抢课助手] 批量课程详情同步失败:', error.message || error);
                            });
                        }
                        STATE.isImporting = false; // 导入一次后自动关闭
                        Persistence.save();
                        UI.render();
                    }
                }
                return originalSend.apply(this, arguments);
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                this._url = url;
                this._headers = {};
                return originalOpen.apply(this, arguments);
            };
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
                this._headers[header] = value;
                return originalSetRequestHeader.apply(this, arguments);
            };
        }
    };
    // --- 抢课执行引擎 ---
    const ExecutionEngine = {
        normalizeLessonInfo(lesson) {
            const teacherNames = uniqueNonEmpty((lesson.teachers || []).map(t => t.nameZh || t.nameEn));
            const scheduleItems = [];
            (lesson.scheduleGroups || []).forEach((group) => {
                (group.schedules || []).forEach((schedule) => {
                    scheduleItems.push({
                        weekdayLabel: WEEKDAY_LABELS[schedule.weekday] || '',
                        startUnit: schedule.startUnit ?? null,
                        endUnit: schedule.endUnit ?? null,
                        weekRange: {
                            startWeek: schedule.startWeek ?? lesson.scheduleStartWeek ?? null,
                            endWeek: schedule.endWeek ?? lesson.scheduleEndWeek ?? null,
                        },
                    });
                });
            });
            const scheduleSummary = uniqueNonEmpty(scheduleItems.map((item) => {
                const unitText = item.startUnit !== null && item.endUnit !== null ? `${item.startUnit}~${item.endUnit}节` : '未知节次';
                const weekText = item.weekRange.startWeek !== null && item.weekRange.endWeek !== null ? `${item.weekRange.startWeek}~${item.weekRange.endWeek}周` : '未知周次';
                return `${weekText} ${item.weekdayLabel || '未知星期'} ${unitText}`;
            }));
            return {
                lessonAssoc: lesson.id,
                lessonCode: lesson.code || null,
                courseCode: lesson.course?.code || null,
                courseName: lesson.course?.nameZh || lesson.nameZh || lesson.course?.nameEn || lesson.nameEn || `Lesson ${lesson.id}`,
                teacherNames,
                teacherText: teacherNames.join('、'),
                campus: lesson.campus?.nameZh || lesson.campus?.nameEn || null,
                credits: lesson.course?.credits ?? null,
                limitCount: lesson.limitCount ?? null,
                selectionRemark: lesson.selectionRemark || null,
                weekDays: Array.isArray(lesson.weekDays) ? lesson.weekDays : [],
                scheduleStartWeek: lesson.scheduleStartWeek ?? null,
                scheduleEndWeek: lesson.scheduleEndWeek ?? null,
                schedule: scheduleItems,
                scheduleSummary,
            };
        },
        async queryLessonInfosByAssocs(lessonAssocs) {
            const normalizedIds = uniqueNonEmpty((lessonAssocs || []).map(id => Number(id))).map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0);
            if (normalizedIds.length === 0) return [];
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) return [];
            const payload = {
                turnId: Number(STATE.turnId),
                studentId: Number(STATE.studentId),
                pageNo: 1,
                pageSize: Math.max(20, normalizedIds.length),
                courseNameOrCode: '', lessonNameOrCode: '', teacherNameOrCode: '', week: '', grade: '',
                departmentId: '', majorId: '', adminclassId: '', campusId: '', openDepartmentId: '',
                courseTypeId: '', coursePropertyId: '', canSelect: true, _canSelect: '可选',
                creditGte: null, creditLte: null, hasCount: null, ids: normalizedIds,
                substitutedCourseId: null, courseSubstitutePoolId: null, sortField: 'lesson', sortType: 'ASC',
            };
            const queryUrl = `/api/v1/student/course-select/query-lesson/${STATE.studentId}/${STATE.turnId}`;
            const response = await fetch(queryUrl, {
                method: 'POST',
                headers: {...STATE.headers, 'Content-Type': 'application/json;charset=UTF-8'},
                body: JSON.stringify(payload),
            });
            const parsed = await response.json().catch(() => ({}));
            const lessons = parsed?.data?.lessons;
            if (parsed.result !== 0 || !Array.isArray(lessons)) return [];
            return lessons.map(lesson => this.normalizeLessonInfo(lesson));
        },
        async syncCourseDetails(lessonAssocs) {
            const infos = await this.queryLessonInfosByAssocs(lessonAssocs);
            if (infos.length === 0) return [];
            const infoByLessonAssoc = new Map(infos.map(info => [info.lessonAssoc, info]));
            let updated = false;
            STATE.courses = STATE.courses.map(course => {
                const info = infoByLessonAssoc.get(course.lessonAssoc);
                if (!info) return course;
                updated = true;
                return {...course, ...info};
            });
            if (updated) {
                Persistence.save();
                UI.render();
            }
            return infos;
        },
        syncCoursesFromServer(statusCourses) {
            if (!Array.isArray(statusCourses)) return;
            const byId = new Map(
                statusCourses
                    .map((course) => {
                        const lessonAssoc = normalizeLessonAssoc(course?.lessonAssoc);
                        if (lessonAssoc === null) return null;
                        return [lessonAssoc, course];
                    })
                    .filter(Boolean)
            );
            if (byId.size === 0) return;

            let changed = false;
            STATE.courses = STATE.courses.map((course) => {
                const serverCourse = byId.get(course.lessonAssoc);
                if (!serverCourse) return course;

                const nextStatus = serverCourse.status === 'success' ? 'success' : 'pending';
                const nextPaused = serverCourse.status === 'paused';
                const nextCourse = {
                    ...course,
                    status: nextStatus,
                    isPaused: nextPaused,
                };

                if (serverCourse.markedForRemoval) {
                    STATE.toBeRemoved.add(course.lessonAssoc);
                } else {
                    STATE.toBeRemoved.delete(course.lessonAssoc);
                }

                if (nextCourse.status !== course.status || nextCourse.isPaused !== course.isPaused) {
                    changed = true;
                }
                return nextCourse;
            });

            if (changed) {
                Persistence.save();
            }
        },
        handleServerFatalError(status) {
            const serverError = status?.error;
            if (!serverError || typeof serverError !== 'object') return false;

            const code = String(serverError.code || 'SERVER_FATAL_ERROR');
            const message = String(serverError.message || '未知严重错误');
            const at = serverError.at ? `\n时间: ${serverError.at}` : '';
            const noticeKey = `${code}|${message}|${serverError.at || ''}`;

            if (STATE.serverErrorNoticeKey !== noticeKey) {
                alert(`本地服务发生严重错误，抢课已终止。\n[${code}] ${message}${at}`);
                STATE.serverErrorNoticeKey = noticeKey;
            }

            STATE.isGrabbing = false;
            STATE.rps = Number(status?.rps || 0);
            STATE.workers = Number(status?.workers || 0);
            this.stopStatusPolling();
            return true;
        },
        async toggleCoursePause(lessonAssocRaw, pause) {
            const lessonAssoc = normalizeLessonAssoc(lessonAssocRaw);
            if (lessonAssoc === null) {
                throw new Error('lessonAssoc 无效');
            }
            if (!STATE.isGrabbing) return;

            const path = pause ? '/course/pause' : '/course/resume';
            const status = await requestLocalApi(path, 'POST', {lessonAssoc});
            this.syncCoursesFromServer(status?.courses);
            STATE.rps = Number(status?.rps || 0);
            STATE.workers = Number(status?.workers || 0);
            UI.render();
        },
        async start() {
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) {
                alert('上下文信息不完整，请先在网页上进行一次手动选课操作以自动捕获');
                return;
            }
            if (STATE.courses.length === 0) {
                alert('意向课程列表为空！');
                return;
            }

            STATE.concurrency = normalizeConcurrency(STATE.concurrency);
            STATE.toBeRemoved.clear();
            STATE.courses.forEach(c => { c.status = 'pending'; });
            await this.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc)).catch(() => {});
            const courses = getCoursePayloadForServer();
            const runnableCount = courses.filter(course => !course.isPaused).length;
            if (runnableCount === 0) {
                alert('没有可执行课程（可能全部已暂停），请检查课程列表');
                UI.render();
                return;
            }

            const payload = {
                studentId: STATE.studentId,
                turnId: STATE.turnId,
                headers: STATE.headers,
                cookie: document.cookie,
                courses,
                concurrency: Number(STATE.concurrency),
                skipCaptcha: Boolean(STATE.skipCaptcha),
            };

            STATE.serverErrorNoticeKey = '';
            await requestLocalApi('/start', 'POST', payload);
            STATE.isGrabbing = true;
            this.startStatusPolling();
            UI.render();
        },
        async stop() {
            const stopResult = await requestLocalApi('/stop', 'POST', {}).catch(() => ({}));
            STATE.isGrabbing = false;
            STATE.rps = 0;
            STATE.workers = 0;
            const removedCourses = uniqueNonEmpty(
                ((stopResult?.removedCourses || []).map(id => normalizeLessonAssoc(id)).filter(id => id !== null))
            ).map(Number);
            const removedSet = new Set([...STATE.toBeRemoved, ...removedCourses]);
            if (removedSet.size > 0) {
                STATE.courses = STATE.courses.filter(course => !removedSet.has(course.lessonAssoc));
            }
            STATE.toBeRemoved.clear();
            STATE.courses.forEach((course) => {
                course.isPaused = false;
                if (course.status !== 'success') {
                    course.status = 'pending';
                }
            });
            Persistence.save();
            this.stopStatusPolling();
            UI.render();
        },
        async fetchStatusOnce() {
            const status = await requestLocalApi('/status', 'GET');
            this.syncCoursesFromServer(status?.courses);
            if (this.handleServerFatalError(status)) {
                UI.render();
                return;
            }
            STATE.rps = Number(status?.rps || 0);
            STATE.workers = Number(status?.workers || 0);
            if (STATE.isGrabbing && status?.running === false) {
                STATE.isGrabbing = false;
                this.stopStatusPolling();
            }
            UI.render();
        },
        startStatusPolling() {
            this.stopStatusPolling();
            this.fetchStatusOnce().catch(() => {});
            STATE.statusIntervalId = setInterval(() => {
                this.fetchStatusOnce().catch(() => {});
            }, 1000);
        },
        stopStatusPolling() {
            if (STATE.statusIntervalId) {
                clearInterval(STATE.statusIntervalId);
                STATE.statusIntervalId = null;
            }
        },
    };

    function init() {
        console.log('[抢课助手] 脚本已启动 ');
        Persistence.load();
        const mountUi = () => {
            UI.createPanel();
            UI.render();
            requestLocalApi('/status', 'GET').then((status) => {
                STATE.isGrabbing = Boolean(status?.running);
                STATE.rps = Number(status?.rps || 0);
                STATE.workers = Number(status?.workers || 0);
                ExecutionEngine.syncCoursesFromServer(status?.courses);
                if (ExecutionEngine.handleServerFatalError(status)) {
                    STATE.isGrabbing = false;
                }
                if (STATE.isGrabbing) {
                    ExecutionEngine.startStatusPolling();
                }
                UI.render();
            }).catch(() => {});
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountUi);
        } else {
            mountUi();
        }
        XHRInterceptor.init();
        // 初始化时，尝试同步课程详情
        if (STATE.courses.length > 0 && STATE.studentId && STATE.turnId && Object.keys(STATE.headers).length > 0) {
            ExecutionEngine.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc)).catch(err => console.warn('[抢课助手] 初始化课程详情同步失败:', err.message || err));
        }
    }

    init();

})();


