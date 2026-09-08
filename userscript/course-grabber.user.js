// ==UserScript==
// @name         复旦选课助手
// @namespace    https://github.com/LinearSakana/fudan-xk-automation
// @version      0.2.2
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
    const FIRST_RUN_NOTICE_KEY = 'first_run_notice_v2';
    const STATE = {
        courses: [], // 意向课程列表 { lessonAssoc: number, status: 'pending' | 'success', isPaused?: boolean, courseName?: string, teacherNames?: string[], schedule?: object[] }
        selectedCourses: [],
        courseConflicts: new Map(), // lessonAssoc -> Array<{ lessonAssoc, lessonNameZh }>
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
        selectedCoursesIntervalId: null,
        toBeRemoved: new Set(),
        serverErrorNoticeKey: '',
        hasFallbackCourse: 0,
    };
    const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    function watchDialog() {
        const handledDialogs = new WeakSet();
        const closeSpecificDialog = () => {
            document.querySelectorAll('div.el-dialog[aria-label="选课结果"]').forEach((dialog) => {
                if (dialog.getClientRects().length === 0) {
                    handledDialogs.delete(dialog);
                    return;
                }
                if (handledDialogs.has(dialog)) return;

                const result = dialog.querySelector('.el-dialog__body .result-content');
                if (result?.textContent.trim() !== '可选人数已满，请有余量后再选') return;

                const closeButton = Array.from(dialog.querySelectorAll('button.el-button.el-button--default[type="button"]'))
                    .find(button => button.textContent.replace(/\s/g, '') === '关闭');
                if (!closeButton) return;

                handledDialogs.add(dialog);
                closeButton.click();
            });
        };

        new MutationObserver(closeSpecificDialog).observe(document, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-hidden'],
        });
        closeSpecificDialog();
    }

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

    function normalizeLessonInfo(lesson) {
        const teacherNames = uniqueNonEmpty((lesson.teachers || []).map(t => t.nameZh || t.nameEn));
        const scheduleItems = [];
        (lesson.scheduleGroups || []).forEach((group) => {
            (group.schedules || []).forEach((schedule) => {
                scheduleItems.push({
                    scheduleId: schedule.id ?? null,
                    scheduleGroupId: schedule.scheduleGroupId ?? group.id ?? null,
                    weekdayLabel: WEEKDAY_LABELS[schedule.weekday] || '',
                    weekday: schedule.weekday ?? null,
                    startUnit: schedule.startUnit ?? null,
                    endUnit: schedule.endUnit ?? null,
                    startTime: schedule.startTime ?? null,
                    endTime: schedule.endTime ?? schedule.entTime ?? null,
                    dateTimePlace: group.dateTimePlace?.text || group.dateTimePlace?.textZh || group.dateTimePlace?.textEn || null,
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
            lessonNameZh: lesson.nameZh || lesson.course?.nameZh || null,
            lessonNameEn: lesson.nameEn || null,
            courseId: lesson.course?.id ?? null,
            courseCode: lesson.course?.code || null,
            courseNameZh: lesson.course?.nameZh || null,
            courseNameEn: lesson.course?.nameEn || null,
            courseName: lesson.course?.nameZh || lesson.nameZh || lesson.course?.nameEn || lesson.nameEn || `Lesson ${lesson.id}`,
            teachers: (lesson.teachers || []).map(teacher => ({
                id: teacher.id ?? null,
                nameZh: teacher.nameZh || null,
                nameEn: teacher.nameEn || null,
            })),
            teacherNames,
            teacherText: teacherNames.join('、'),
            campus: lesson.campus?.nameZh || lesson.campus?.nameEn || null,
            credits: lesson.course?.credits ?? null,
            limitCount: lesson.limitCount ?? null,
            selectionRemark: lesson.selectionRemark || null,
            dateTimePlace: lesson.dateTimePlace?.text || lesson.dateTimePlace?.textZh || lesson.dateTimePlace?.textEn || null,
            examDate: lesson.examDate || null,
            totalPeriod: lesson.totalPeriod ?? null,
            department: lesson.course?.department || null,
            openDepartment: lesson.openDepartment || null,
            courseTableType: lesson.course?.courseTableType || null,
            examMode: lesson.examMode || null,
            teachLang: lesson.teachLang || null,
            weekDays: Array.isArray(lesson.weekDays) ? lesson.weekDays : [],
            scheduleStartWeek: lesson.scheduleStartWeek ?? null,
            scheduleEndWeek: lesson.scheduleEndWeek ?? null,
            schedule: scheduleItems,
            scheduleSummary,
        };
    }

    function buildCourseConflicts(courses, selectedCourses) {
        const overlaps = (startA, endA, startB, endB) => {
            const values = [startA, endA, startB, endB];
            if (values.some(value => value == null || value === '' || !Number.isFinite(Number(value)))) return false;
            return Number(startA) <= Number(endB) && Number(startB) <= Number(endA);
        };
        const schedulesOverlap = (a, b) => (a.schedule || []).some(left =>
            (b.schedule || []).some(right => {
                if (!left.weekday || Number(left.weekday) !== Number(right.weekday)) return false;
                const leftWeeks = left.weekRange || {};
                const rightWeeks = right.weekRange || {};
                if (leftWeeks.endWeek != null && rightWeeks.startWeek != null && Number(leftWeeks.endWeek) < Number(rightWeeks.startWeek)) return false;
                if (rightWeeks.endWeek != null && leftWeeks.startWeek != null && Number(rightWeeks.endWeek) < Number(leftWeeks.startWeek)) return false;
                return overlaps(left.startUnit, left.endUnit, right.startUnit, right.endUnit);
            })
        );
        const isSportsCourse = course => (course.courseTableType?.nameZh || '').includes('通识教育专项教育课程：体育');  // 目前仅判断体育课冲突
        const candidates = new Map([...courses, ...selectedCourses].map(course => [Number(course.lessonAssoc), course]));
        return new Map([...candidates.values()].map(course => {
            const lessonAssoc = Number(course.lessonAssoc);
            const current = candidates.get(lessonAssoc);
            const conflicts = [];
            for (const [otherId, other] of candidates) {
                if (otherId === lessonAssoc) continue;
                if ((current.courseCode && current.courseCode === other.courseCode)
                    || schedulesOverlap(current, other)
                    || (isSportsCourse(current) && isSportsCourse(other))) {
                    conflicts.push({
                        lessonAssoc: otherId,
                        lessonNameZh: other.lessonNameZh || other.courseName || `Lesson ${otherId}`
                    });
                }
            }
            return [lessonAssoc, conflicts];
        }));
    }

    function rebuildConflicts() {
        STATE.courseConflicts = buildCourseConflicts(STATE.courses, STATE.selectedCourses);
    }

    function getCoursePayload() {
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

    async function requestApi(path, method = 'GET', payload = null) {
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

    function showFirstRunNotice() {
        if (localStorage.getItem(FIRST_RUN_NOTICE_KEY)) return;

        const overlay = document.createElement('div');
        overlay.id = 'grabber-first-run-notice';

        overlay.innerHTML = `
        <div style="
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: rgba(0, 0, 0, 0.45);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            box-sizing: border-box;
        ">
            <div role="dialog" aria-modal="true" aria-labelledby="grabber-first-run-title" style="
                width: 460px;
                max-width: 100%;
                background: #fff;
                color: #2d3748;
                border-radius: 16px;
                padding: 24px;
                box-shadow: 0 20px 60px rgba(0,0,0,.25);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
                             Roboto, Helvetica, Arial, sans-serif;
            ">
                <div id="grabber-first-run-title" style="
                    font-size: 20px;
                    font-weight: 600;
                    margin-bottom: 14px;
                ">
                    欢迎使用复旦选课助手
                </div>

                <div style="
                    font-size: 14px;
                    line-height: 1.7;
                    color: #4a5568;
                ">
                    <p>初次见面，先确认一下本地服务是否正常运行（默认地址为 <code>127.0.0.1:30522</code> ）</p>
                    <p>
                        出现下列情况，需要<b>重置状态，并手动点一次选课</b>：
                    </p>
                    <ol style="padding-left: 22px;">
                        <li>初次或间隔了很长时间打开选课网页</li>
                        <li>在别的标签页打开过选课网页</li>
                        <li>悬浮窗右上角提示“状态已过期”</li>
                        <li>其他任何异常情况</li>
                        <li>以防万一，抢课开始前也可以重置一次</li>
                    </ol>
                    <p>
                        尽量只在当前标签页操作，不要为了浏览课表而新开标签页（选课助手自带课程表功能），否则可能导致抢课失败哦~
                    </p>
                </div>

                <button id="grabber-first-run-confirm" style="
                    width: 100%;
                    margin-top: 16px;
                    padding: 10px 16px;
                    border: none;
                    border-radius: 9px;
                    background: #3182ce;
                    color: #fff;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                ">
                    承知！(・ω・)ゞ
                </button>
            </div>
        </div>
    `;

        document.body.appendChild(overlay);

        const confirmButton = document.getElementById('grabber-first-run-confirm');
        const close = () => {
            localStorage.setItem(FIRST_RUN_NOTICE_KEY, '1');
            overlay.remove();
        };
        confirmButton.addEventListener('click', close);
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close();
            if (event.key === 'Tab') {
                event.preventDefault();
                confirmButton.focus();
            }
        });
        confirmButton.focus();
    }

    const Timetable = {
        panel: null,
        courses: [],
        conflicts: new Map(),
        async open() {
            if (!this.panel) this.create();
            if (!this.panel.hidden) return;
            this.panel.hidden = false;
            document.getElementById('timetable-btn').setAttribute('aria-expanded', 'true');
            this.panel.querySelector('[data-action="close"]').focus();
            await this.refresh();
        },
        create() {
            const panel = document.createElement('div');
            panel.id = 'grabber-timetable';
            panel.hidden = true;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', '课程表');
            panel.innerHTML = `
                <div class="grabber-header">
                    <span class="grabber-title">🗓️ 我的课程表</span>
                    <div class="timetable-legend"><span class="timetable-selected">已选</span><span class="timetable-intended">意向</span><span class="timetable-conflict">存在冲突</span></div>
                    <div class="timetable-actions">
                        <button class="grabber-icon-btn" data-action="refresh" title="手动刷新" aria-label="刷新课程表">↻</button>
                        <button class="grabber-icon-btn" data-action="close" title="关闭" aria-label="关闭课程表">×</button>
                    </div>
                </div>
                <div class="timetable-grid"></div>
                <div class="timetable-message" role="status" aria-live="polite"></div>
                ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => `<div class="timetable-resize" data-edge="${edge}"></div>`).join('')}
            `;
            document.body.appendChild(panel);
            this.panel = panel;
            UI.makeDraggable(panel, panel.querySelector('.grabber-header'));
            panel.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refresh());
            const close = () => {
                panel.hidden = true;
                UI.hideHoverCard();
                document.getElementById('timetable-btn').setAttribute('aria-expanded', 'false');
                document.getElementById('timetable-btn').focus();
            };
            panel.querySelector('[data-action="close"]').addEventListener('click', close);
            panel.addEventListener('keydown', event => {
                if (event.key === 'Escape') close();
            });
            const showDetails = (event) => {
                const block = event.target.closest('[data-course-index]');
                if (!block) return UI.hideHoverCard();
                const index = Number(block.dataset.courseIndex);
                const course = this.courses[index];
                const rect = block.getBoundingClientRect();
                UI.showHoverCard(course, `timetable-${index}`, event.clientX || rect.right, event.clientY || rect.top,
                    this.conflicts.get(Number(course.lessonAssoc)) || [], true, block);
            };
            panel.addEventListener('mousemove', showDetails);
            panel.addEventListener('focusin', showDetails);
            panel.addEventListener('mouseleave', () => UI.hideHoverCard());
            panel.addEventListener('focusout', () => UI.hideHoverCard());
            panel.querySelector('.timetable-grid').addEventListener('scroll', () => UI.hideHoverCard());
            panel.addEventListener('pointerdown', event => {
                const handle = event.target.closest('[data-edge]');
                if (!handle || event.button !== 0) return;
                event.preventDefault();
                UI.hideHoverCard();
                const edge = handle.dataset.edge;
                const rect = panel.getBoundingClientRect();
                const move = e => {
                    const dx = e.clientX - event.clientX, dy = e.clientY - event.clientY;
                    const width = Math.min(window.innerWidth - 16, Math.max(0, rect.width + (edge.includes('w') ? -dx : dx)));
                    const height = Math.min(window.innerHeight - 16, Math.max(280, rect.height + (edge.includes('n') ? -dy : dy)));
                    if (/[ew]/.test(edge)) {
                        panel.style.width = `${width}px`;
                        panel.style.left = `${edge.includes('w') ? rect.right - panel.getBoundingClientRect().width : rect.left}px`;
                    }
                    if (/[ns]/.test(edge)) {
                        panel.style.height = `${height}px`;
                        panel.style.top = `${edge.includes('n') ? rect.bottom - height : rect.top}px`;
                    }
                };
                handle.setPointerCapture(event.pointerId);
                handle.addEventListener('pointermove', move);
                handle.addEventListener('lostpointercapture', () => handle.removeEventListener('pointermove', move), {once: true});
            });
        },
        async refresh() {
            const button = this.panel.querySelector('[data-action="refresh"]');
            if (button.disabled) return;
            const message = this.panel.querySelector('.timetable-message');
            button.disabled = true;
            this.panel.setAttribute('aria-busy', 'true');
            message.textContent = '正在更新课程表…';
            UI.hideHoverCard();
            try {
                if (!STATE.studentId || !STATE.turnId || !Object.keys(STATE.headers).length) {
                    throw new Error('请先在选课页面捕获课程信息，再点击刷新');
                }
                const studentId = STATE.studentId, turnId = STATE.turnId, headers = STATE.headers;
                const selected = await ExecutionEngine.querySelectedCourses();
                if (studentId !== STATE.studentId || turnId !== STATE.turnId || headers !== STATE.headers) {
                    throw new Error('选课上下文已变更，请重新刷新');
                }
                const selectedIds = new Set(selected.map(course => Number(course.lessonAssoc)));
                this.courses = [...new Map([...STATE.courses, ...selected].map(course =>
                    [Number(course.lessonAssoc), {
                        ...course,
                        timetableSelected: selectedIds.has(Number(course.lessonAssoc))
                    }])).values()];
                this.conflicts = buildCourseConflicts(this.courses, []);
                this.render();
                UI.render();
            } catch (error) {
                message.textContent = `${error.message || error}${this.courses.length ? '（保留上次课表）' : ''}`;
            } finally {
                button.disabled = false;
                this.panel.removeAttribute('aria-busy');
            }
        },
        render() {
            const entries = [];
            const scheduled = new Set();
            this.courses.forEach((course, index) => {
                const seen = new Set();
                for (const schedule of course.schedule || []) {
                    const day = Number(schedule.weekday), start = Number(schedule.startUnit),
                        end = Number(schedule.endUnit);
                    if (![day, start, end].every(Number.isInteger) || day < 1 || day > 7 || start < 1 || end > 14 || start > end) continue;
                    scheduled.add(index);
                    for (const [first, last] of [[1, 5], [6, 10], [11, 14]]) {
                        const from = Math.max(start, first), to = Math.min(end, last);
                        const key = `${day}-${from}-${to}`;
                        if (from > to || seen.has(key)) continue;
                        seen.add(key);
                        entries.push({index, day, start: from, end: to});
                    }
                }
            });
            const days = [1, 2, 3, 4, 5, 6, 7].filter(day => day <= 5 || entries.some(entry => entry.day === day));
            const row = unit => unit + (unit > 5 ? 1 : 0) + (unit > 10 ? 1 : 0);
            const grid = this.panel.querySelector('.timetable-grid');
            grid.style.setProperty('--days', days.length);
            grid.innerHTML = days.map(day => {
                const blocks = entries.filter(entry => entry.day === day).sort((a, b) => a.start - b.start || b.end - a.end);
                let group = [], ends = [], groupEnd = 0;
                const finishGroup = () => group.forEach(entry => entry.lanes = ends.length);
                for (const entry of blocks) {
                    if (entry.start > groupEnd) {
                        finishGroup();
                        group = [];
                        ends = [];
                        groupEnd = 0;
                    }
                    let lane = ends.findIndex(end => end < entry.start);
                    if (lane < 0) lane = ends.length;
                    ends[lane] = entry.end;
                    entry.lane = lane;
                    group.push(entry);
                    groupEnd = Math.max(groupEnd, entry.end);
                }
                finishGroup();
                return `<div class="timetable-day" aria-label="${WEEKDAY_LABELS[day]}">
                    ${Array.from({length: 14}, (_, i) => `<div class="timetable-cell" style="grid-row:${row(i + 1)}" aria-hidden="true"></div>`).join('')}
                    ${blocks.map(entry => {
                    const course = this.courses[entry.index];
                    const conflict = this.conflicts.get(Number(course.lessonAssoc))?.length;
                    const name = course.courseName || course.lessonNameZh || `Lesson ${course.lessonAssoc}`;
                    const code = course.lessonCode || course.courseCode || '待同步';
                    const label = `${name} ${code}，${WEEKDAY_LABELS[day]} ${entry.start}~${entry.end}节，${course.timetableSelected ? '已选' : '意向'}${conflict ? '，存在冲突' : ''}`;
                    return `<button class="timetable-course ${course.timetableSelected ? 'timetable-selected' : 'timetable-intended'}${conflict ? ' timetable-conflict' : ''}"
                            data-course-index="${entry.index}" aria-label="${escapeHtml(label)}"
                            style="grid-row:${row(entry.start)} / ${row(entry.end) + 1}; width:calc(${100 / entry.lanes}% - 4px); margin-left:calc(${entry.lane * 100 / entry.lanes}% + 2px)">
                            <span>${escapeHtml(name)}</span><small>${escapeHtml(code)}</small>
                        </button>`;
                }).join('')}
                </div>`;
            }).join('');
            const missing = this.courses.length - scheduled.size;
            this.panel.querySelector('.timetable-message').textContent = this.courses.length
                ? `${missing ? `${missing} 门课程暂无有效时间 · ` : ''}仅支持手动刷新哦~`
                : '暂无已选或意向课程 · 仅支持手动刷新哦~';
        },
    };

    // --- UI 模块 ---
    const UI = {
        panel: null,
        courseListEl: null,
        hoverCardEl: null,
        hoverTriggerEl: null,
        hoverCourseIndex: -1,
        lastRenderState: null,
        lastButtonsState: null,
        createPanel() {
            if (document.getElementById('grabber-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'grabber-panel';
            panel.setAttribute('role', 'region');
            panel.setAttribute('aria-label', '选课助手');
            panel.innerHTML = `
                <div class="grabber-header">
                    <span class="grabber-title">选课助手 <button id="timetable-btn" class="grabber-icon-btn" title="打开课程表" aria-label="打开课程表" aria-expanded="false" aria-haspopup="dialog" aria-controls="grabber-timetable">🗓️</button></span>
                    <span id="header-student-id" class="header-student-id" title="StudentID" style="display: none;"></span>
                </div>
                <div class="grabber-body">
                    <div class="grabber-controls">
                        <label class="checkbox-label" title="跳过滑动验证码（按需设置）">
                            <input type="checkbox" id="skip-captcha-checkbox">
                            <span class="checkmark"></span>
                            跳过验证
                        </label>
                    <div class="rps-display" title="本地服务状态" aria-label="本地服务状态">
                            RPS: <span id="rps-value">0</span> | Workers: <span id="workers-value">0</span>
                        </div>
                    </div>
                    <div class="grabber-slider-group">
                        <label for="concurrency-slider" id="concurrency-num">并发数</label>
                        <input type="range" id="concurrency-slider" min="1" max="10" value="2">
                        <span id="concurrency-value" class="badge">2</span>
                    </div>
                    <ul id="course-list" aria-label="意向课程"></ul>
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
            hoverCard.setAttribute('role', 'tooltip');
            hoverCard.setAttribute('aria-hidden', 'true');
            document.body.appendChild(hoverCard);
            this.hoverCardEl = hoverCard;
        },
        applyStyles() {
            const styles = `
                #grabber-panel, #grabber-timetable { position: fixed; top: 80px; right: 20px; width: 320px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 16px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.05); z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; overflow: hidden; transition: box-shadow 0.3s ease; display: flex; flex-direction: column; }
                #grabber-timetable { top: 80px; left: max(8px, calc(50vw - 360px)); right: auto; width: min(640px, calc(100vw - 16px)); min-width: min(400px, calc(100vw - 16px)); height: min(650px, calc(100dvh - 96px)); max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); box-sizing: border-box; }
                #grabber-timetable[hidden] { display: none; }
                #grabber-timetable:not([hidden]) { animation: timetable-enter 0.2s ease-out; }
                @keyframes timetable-enter { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }
                .grabber-icon-btn { border: 0; border-radius: 8px; padding: 2px 5px; background: transparent; color: inherit; font: inherit; line-height: 1.2; cursor: pointer; transition: background 0.2s, transform 0.2s; }
                .grabber-icon-btn:hover:not(:disabled) { background: rgba(255,255,255,0.2); transform: translateY(-1px); }
                .grabber-icon-btn:focus-visible { outline: 2px solid #90cdf4; outline-offset: 2px; }
                #timetable-btn { margin-left: 3px; font-size: 15px; }
                .timetable-actions { display: flex; gap: 4px; font-size: 21px; }
                #grabber-timetable .grabber-header { flex-shrink: 0; gap: 8px; flex-wrap: wrap; }
                .timetable-legend { display: flex; gap: 6px; margin-left: auto; font-size: 10px; line-height: 1.4; }
                .timetable-legend span { padding: 3px 9px; border-radius: 6px; }
                .timetable-selected { color: #276749; background: linear-gradient(145deg, #f0fff4, #d6f5e5); border: 1px solid #9ae6b4; }
                .timetable-intended { color: #2b6cb0; background: linear-gradient(145deg, #f4faff, #e0edff); border: 1px dashed #90b8e5; }
                .timetable-conflict { border: 1px solid #d69e2e; box-shadow: inset 3px 0 #d69e2e; background-image: repeating-linear-gradient(135deg, transparent 0 6px, rgba(236,185,38,0.09) 6px 12px); }
                .timetable-legend .timetable-conflict { color: #97651c; background-color: #fffaf0; padding-left: 11px; }
                .timetable-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(var(--days, 5), minmax(0, 1fr)); gap: 5px; margin-top: 12px; padding: 0 12px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #cbd5e0 transparent; }
                .timetable-day { display: grid; min-width: 0; min-height: 364px; grid-template-rows: repeat(5, minmax(0, 1fr)) 7px repeat(5, minmax(0, 1fr)) 7px repeat(4, minmax(0, 1fr)); }
                .timetable-cell { grid-column: 1; background: rgba(237,242,247,0.55); border-bottom: 1px solid rgba(203,213,224,0.3); }
                .timetable-cell:first-child { border-radius: 7px 7px 0 0; }
                .timetable-cell:last-of-type { border-radius: 0 0 7px 7px; }
                .timetable-course { grid-column: 1; z-index: 1; min-width: 0; min-height: 0; margin-top: 2px; margin-bottom: 2px; padding: 3px 5px; border-radius: 7px; font: inherit; text-align: left; cursor: default; display: flex; flex-direction: column; justify-content: center; overflow: hidden; box-sizing: border-box; transition: transform 0.18s, box-shadow 0.18s; }
                .timetable-course span, .timetable-course small { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex-shrink: 0; width: 100%; line-height: 1.35; }
                .timetable-course span { font-size: 11px; font-weight: 600; }
                .timetable-course small { font-size: 9px; opacity: 0.75; }
                .timetable-course:hover, .timetable-course:focus-visible { z-index: 2; transform: translateY(-1px); outline: 2px solid rgba(66,153,225,0.45); outline-offset: 1px; box-shadow: 0 4px 12px rgba(30,60,114,0.15); }
                .timetable-message { flex: 0 0 auto; min-height: 14px; padding: 9px 14px 11px; font-size: 10px; color: #718096; line-height: 1.4; }
                .timetable-resize { position: absolute; z-index: 3; touch-action: none; }
                .timetable-resize[data-edge="n"], .timetable-resize[data-edge="s"] { left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
                .timetable-resize[data-edge="e"], .timetable-resize[data-edge="w"] { top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }
                .timetable-resize[data-edge*="n"] { top: 0; }
                .timetable-resize[data-edge*="s"] { bottom: 0; }
                .timetable-resize[data-edge*="e"] { right: 0; }
                .timetable-resize[data-edge*="w"] { left: 0; }
                .timetable-resize[data-edge="ne"], .timetable-resize[data-edge="sw"] { width: 10px; height: 10px; cursor: nesw-resize; }
                .timetable-resize[data-edge="nw"], .timetable-resize[data-edge="se"] { width: 10px; height: 10px; cursor: nwse-resize; }
                .course-hover-card.hover-timetable { width: 460px; max-width: calc(100vw - 44px); max-height: calc(100dvh - 44px); overflow: auto; }
                .hover-timetable .hover-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; }
                .hover-timetable .hover-row { min-width: 0; }
                .hover-timetable .hover-value { min-width: 0; overflow-wrap: anywhere; }
                .hover-timetable .hover-wide { grid-column: 1 / -1; }
                .hover-timetable .hover-bottom { display: flex; align-items: flex-start; gap: 12px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e2e8f0; }
                .course-hover-card.hover-timetable .hover-schedule { flex: 1; min-width: 0; margin: 0; padding: 0; border: 0; overflow-wrap: anywhere; }
                .course-hover-card.hover-timetable .hover-conflict { flex-shrink: 0; margin-top: 0; }
                @media (max-width: 480px) { .hover-timetable .hover-fields { grid-template-columns: minmax(0, 1fr); } .hover-timetable .hover-bottom { flex-direction: column; } }
                @media (prefers-reduced-motion: reduce) { #grabber-timetable, #grabber-timetable *, #timetable-btn { animation: none !important; transition: none !important; } }
                .grabber-header { padding: 8px 16px; background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%); color: white; display: flex; align-items: center; justify-content: space-between; cursor: move; user-select: none; }
                .grabber-title { font-weight: 400; font-size: 14px; letter-spacing: 0.5px; }
                .header-student-id { font-size: 12px; opacity: 0.9; background: rgba(255,255,255,0.2); padding: 2px 8px; border-radius: 12px; font-variant-numeric: tabular-nums; }
                .grabber-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
                .grabber-controls { display: flex; justify-content: space-between; align-items: center; }
                .checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: #4a5568; user-select: none; }
                .checkbox-label input { position: absolute; width: 1px; height: 1px; opacity: 0; }
                .checkbox-label input:focus-visible + .checkmark { outline: 2px solid #3182ce; outline-offset: 2px; }
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
                #course-list li.course-conflict { position: relative; }
                #course-list li.course-conflict::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: repeating-linear-gradient(135deg, rgba(25, 25, 25, 0.045) 0 6px, rgba(236, 185, 38, 0.10) 6px 12px); }
                .course-hover-card .hover-conflict { width: fit-content; max-width: 240px; box-sizing: border-box; margin-top: 10px; padding: 8px 10px; border: 1px solid #f3dfad; border-radius: 8px; background: #fffaf0; color: #97651c; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
                .course-main { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
                .course-title { font-weight: 600; color: #2d3748; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .course-teachers { font-size: 11px; color: #718096; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .course-status-pill { width: 14px; height: 14px; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 0 1px #e2e8f0; transition: all 0.2s; padding: 0; }
                .course-status-pill:not(:disabled) { cursor: pointer; }
                .course-status-pill:not(:disabled):hover { transform: scale(1.15); }
                .status-running { background: #4299e1; box-shadow: 0 0 0 1px #4299e1, 0 0 8px rgba(66, 153, 225, 0.4); animation: pulse 2s infinite; }
                .status-success { background: #34d399; box-shadow: none; border: 1px solid #2f855a; }
                .status-paused { background: #a0aec0; box-shadow: 0 0 0 1px #a0aec0; }
                @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(66, 153, 225, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(66, 153, 225, 0); } 100% { box-shadow: 0 0 0 0 rgba(66, 153, 225, 0); } }
                .course-actions button { background: none; border: none; cursor: pointer; font-size: 14px; color: #e53e3e; opacity: 0.6; transition: all 0.2s; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
                .course-actions button:hover { opacity: 1; background: #fff5f5; }
                #grabber-panel button:focus-visible, #grabber-panel input:focus-visible { outline: 2px solid #3182ce; outline-offset: 2px; }
                .grabber-sub-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
                .btn-secondary { padding: 6px 0; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; background: #ffffff; color: #4a5568; font-size: 12px; font-weight: 500; transition: all 0.2s; }
                .btn-secondary:hover:not(:disabled) { background: #f7fafc; border-color: #cbd5e0; }
                .btn-secondary.danger:hover:not(:disabled) { background: #fff5f5; color: #e53e3e; border-color: #feb2b2; }
                .btn-start { width: 100%; padding: 12px; font-size: 15px; font-weight: 600; background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); color: white; border: none; border-radius: 10px; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 12px rgba(72, 187, 120, 0.3); }
                .btn-start:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(72, 187, 120, 0.4); }
                .btn-start:active:not(:disabled) { transform: translateY(1px); }
                .btn-start.grabbing { background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%); box-shadow: 0 4px 12px rgba(229, 62, 62, 0.3); }
                .btn-start.grabbing:hover:not(:disabled) { box-shadow: 0 6px 16px rgba(229, 62, 62, 0.4); }
                button:disabled { cursor: not-allowed; opacity: 0.5; }
                .btn-secondary.important-hint { border-color: #f6ad55; color: #c05621; box-shadow: 0 0 0 2px rgba(246, 173, 85, 0.12), 0 0 10px rgba(246, 173, 85, 0.35); animation: important-hint-glow 1.6s ease-in-out infinite alternate; }               
                @keyframes important-hint-glow { to { box-shadow: 0 0 0 3px rgba(246, 173, 85, 0.18), 0 0 16px rgba(246, 173, 85, 0.65); } }
                @media (prefers-reduced-motion: reduce) { #grabber-panel, #grabber-panel *, .course-hover-card { animation: none !important; transition: none !important; } }
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
        buildCourseHoverCard(course, conflicts = STATE.courseConflicts.get(Number(course.lessonAssoc)) || [], timetable = false) {
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
                <div class="hover-fields">
                <div class="hover-row"><div class="hover-key">课程 ID</div><div class="hover-value">${escapeHtml(course.lessonAssoc)}</div></div>
                <div class="hover-row"><div class="hover-key">代码</div><div class="hover-value">${escapeHtml(courseCode)}</div></div>
                <div class="hover-row"><div class="hover-key">教师</div><div class="hover-value">${escapeHtml(teacherText)}</div></div>
                <div class="hover-row"><div class="hover-key">学分</div><div class="hover-value">${escapeHtml(creditText)}</div></div>
                <div class="hover-row"><div class="hover-key">校区</div><div class="hover-value">${escapeHtml(campusText)}</div></div>
                <div class="hover-row"><div class="hover-key">容量</div><div class="hover-value">${escapeHtml(limitText)}</div></div>
                ${timetable ? [
                ['教学班', course.lessonCode], ['总学时', course.totalPeriod],
                ['授课语言', course.teachLang?.nameZh || course.teachLang?.nameEn],
                ['考核方式', course.examMode?.nameZh || course.examMode?.nameEn],
                ['开课院系', course.openDepartment?.nameZh || course.openDepartment?.nameEn],
                ['课程类别', course.courseTableType?.nameZh || course.courseTableType?.nameEn],
            ].map(([key, value]) => `<div class="hover-row"><div class="hover-key">${key}</div><div class="hover-value">${escapeHtml(value ?? '待同步')}</div></div>`).join('') : ''}
                ${timetable && course.examDate ? `<div class="hover-row hover-wide"><div class="hover-key">考试时间</div><div class="hover-value">${escapeHtml(course.examDate)}</div></div>` : ''}
                <div class="hover-row hover-wide"><div class="hover-key">备注</div><div class="hover-value">${escapeHtml(remarkText)}</div></div>
                </div>
                <div class="hover-bottom">
                <div class="hover-schedule"><div class="hover-key">${timetable ? '时间 / 地点' : '时间'}</div><div class="hover-schedule-items">${timetable
                ? escapeHtml(course.dateTimePlace) || uniqueNonEmpty((course.schedule || []).map(item => item.dateTimePlace)).map(escapeHtml).join('<br>') || (course.scheduleSummary || []).map(escapeHtml).join('<br>') || '待获取'
                : this.formatScheduleDetails(course)}</div></div>
                ${conflicts.length ? `<div class="hover-conflict">⚠️ 当前课程与${conflicts.map(item => escapeHtml(item.lessonNameZh)).join('，')}存在冲突，您可根据自身情况，决定该课程的去留</div>` : ''}
                </div>
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
        showHoverCard(course, index, clientX, clientY, conflicts, timetable = false, trigger = null) {
            if (!this.hoverCardEl || !course) return;
            if (this.hoverTriggerEl !== trigger) {
                this.hoverTriggerEl?.removeAttribute('aria-describedby');
                this.hoverTriggerEl = trigger;
                this.hoverTriggerEl?.setAttribute('aria-describedby', this.hoverCardEl.id);
            }
            if (this.hoverCourseIndex !== index) {
                this.hoverCardEl.classList.toggle('hover-timetable', timetable);
                this.hoverCardEl.innerHTML = this.buildCourseHoverCard(course, conflicts, timetable);
                this.hoverCourseIndex = index;
            }
            this.hoverCardEl.classList.add('show');
            this.hoverCardEl.setAttribute('aria-hidden', 'false');
            this.positionHoverCard(clientX, clientY);
        },
        hideHoverCard() {
            if (!this.hoverCardEl) return;
            this.hoverCardEl.classList.remove('show');
            this.hoverCardEl.setAttribute('aria-hidden', 'true');
            this.hoverTriggerEl?.removeAttribute('aria-describedby');
            this.hoverTriggerEl = null;
            this.hoverCourseIndex = -1;
        },
        makeDraggable(element, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = (e) => {
                if (e.button !== 0 || e.target.closest('button')) return;
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
            if (!this.courseListEl) return;
            const studentIdEl = document.getElementById('header-student-id');
            const studentIdText = STATE.studentId ? STATE.studentId : '未捕获';
            if (studentIdEl) {
                if (STATE.hasFallbackCourse === 1) {
                    studentIdEl.textContent = '状态已过期';
                } else {
                    studentIdEl.textContent = 'ID: ' + studentIdText;
                }
                studentIdEl.style.display = STATE.studentId ? 'inline-block' : 'none';
            }
            const resetBtn = document.getElementById('reset-btn');
            if (resetBtn) {
                resetBtn.classList.toggle('important-hint', STATE.hasFallbackCourse === 1);
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

            // --- 课程列表缓存 ---
            const currentCoursesState = STATE.courses.map(c =>
                `${c.lessonAssoc}|${c.status}|${c.isPaused}|${c.courseName}|${c.teacherNames?.join(',')}`
            ).join(';') + `|isGrabbing:${STATE.isGrabbing}|conflicts:${JSON.stringify([...STATE.courseConflicts])}`;

            if (this.lastRenderState !== currentCoursesState) {
                this.lastRenderState = currentCoursesState;
                this.courseListEl.innerHTML = '';

                const fragment = document.createDocumentFragment();
                STATE.courses.forEach((course, index) => {
                    const li = document.createElement('li');
                    li.dataset.index = String(index);
                    if (STATE.courseConflicts.get(Number(course.lessonAssoc))?.length) {
                        li.classList.add('course-conflict');
                    }
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
                        const actionLabel = course.status === 'success' ? `${courseName}：成功` : `${course.isPaused ? '继续' : '暂停'} ${courseName}`;
                        rightContent = `<button class="course-status-pill ${statusClass}" data-index="${index}" data-action="toggle-pause" title="${escapeHtml(statusText)}" aria-label="${escapeHtml(actionLabel)}" ${disabledAttr}></button>`;
                    } else {
                        rightContent = `<div class="course-actions"><button data-index="${index}" data-action="delete" title="删除" aria-label="删除 ${escapeHtml(courseName)}">✖</button></div>`;
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

            // --- 按钮状态缓存 ---
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
            document.getElementById('timetable-btn').addEventListener('click', () => Timetable.open());
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
                    rebuildConflicts();
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
                this.showHoverCard(STATE.courses[index], index, e.clientX, e.clientY, undefined, false, li);
            });
            this.courseListEl.addEventListener('focusin', (e) => {
                const li = e.target.closest('li[data-index]');
                if (!li) return;
                const index = Number(li.dataset.index);
                if (!Number.isInteger(index) || index < 0 || index >= STATE.courses.length) return;
                const rect = li.getBoundingClientRect();
                this.showHoverCard(STATE.courses[index], index, rect.right, rect.top, undefined, false, e.target);
            });
            this.courseListEl.addEventListener('focusout', (e) => {
                if (!e.relatedTarget || !this.courseListEl.contains(e.relatedTarget)) this.hideHoverCard();
            });
            this.courseListEl.addEventListener('mouseleave', () => {
                this.hideHoverCard();
            });
            this.courseListEl.addEventListener('scroll', () => {
                this.hideHoverCard();
            });
            const grabBtn = document.getElementById('grab-btn');

            grabBtn.addEventListener('mouseenter', () => {
                if (![...STATE.courseConflicts.values()].some(conflicts => conflicts.length > 0)) {
                    this.hideHoverCard();
                    return;
                }
                const rect = grabBtn.getBoundingClientRect();
                this.hoverCardEl.innerHTML = '互斥课程可以正常参与抢课 <br><br> 对于每一个已抢到的课程， <br> 与之冲突的其他课程会自动暂停';
                this.hoverCardEl.classList.add('show');
                this.hoverCardEl.setAttribute('aria-hidden', 'false');
                this.positionHoverCard(rect.right, rect.top);
            });

            grabBtn.addEventListener('mouseleave', () => this.hideHoverCard());

            grabBtn.addEventListener('click', async () => {
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
                    STATE.courseConflicts.clear();
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
                STATE.selectedCourses = [];
                rebuildConflicts();
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
                            rebuildConflicts();
                            ExecutionEngine.syncCourseDetails([lessonAssoc])
                                .catch((error) => {
                                    console.warn('[抢课助手] 单课程详情同步失败:', error.message || error);
                                });
                        }
                        Persistence.save();
                        ExecutionEngine.refreshAllCourseDetails();
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
                        rebuildConflicts();
                        if (newCoursesCount > 0) {
                            ExecutionEngine.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc))
                                .catch((error) => {
                                    console.warn('[抢课助手] 批量课程详情同步失败:', error.message || error);
                                });
                        }
                        STATE.isImporting = false; // 导入一次后自动关闭
                        Persistence.save();
                        ExecutionEngine.refreshAllCourseDetails();
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
        isFallbackCourse(course) {
            return !course.courseName || !Array.isArray(course.teacherNames) || course.teacherNames.length === 0;
        },
        refreshAllCourseDetails() {
            if (STATE.courses.some(c => this.isFallbackCourse(c))) {
                this.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc))
                    .finally(() => {
                        STATE.hasFallbackCourse =
                            STATE.courses.some(c => this.isFallbackCourse(c)) ? 1 : 0;
                        UI.render();
                    });
            } else {
                STATE.hasFallbackCourse = 0;
                UI.render();
            }
        },
        async queryLessonInfo(lessonAssocs) {
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
            return lessons.map(lesson => normalizeLessonInfo(lesson));
        },
        async syncCourseDetails(lessonAssocs) {
            const [infos] = await Promise.all([
                this.queryLessonInfo(lessonAssocs),
                this.querySelectedCourses().catch(error => console.warn('[抢课助手] 冲突检查课表同步失败:', error.message || error)),
            ]);
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
            }
            rebuildConflicts();
            UI.render();
            return infos;
        },
        async querySelectedCourses() {
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) return [];
            const studentId = STATE.studentId;
            const turnId = STATE.turnId;
            const headers = STATE.headers;
            const queryUrl = `/api/v1/student/course-select/selected-lessons/${encodeURIComponent(STATE.turnId)}/${encodeURIComponent(STATE.studentId)}`;
            const response = await fetch(queryUrl, {headers: {...STATE.headers}});
            const parsed = await response.json().catch(() => ({}));
            if (!response.ok || parsed?.result !== 0 || !Array.isArray(parsed?.data)) {
                throw new Error(parsed?.message || '已选课程响应格式无效');
            }
            const selectedCourses = parsed.data.map(lesson => ({
                ...normalizeLessonInfo(lesson),
                status: 'success',
                isPaused: true,
                selectedConfirmed: true,
            }));
            if (STATE.studentId !== studentId || STATE.turnId !== turnId || STATE.headers !== headers) return [];
            STATE.selectedCourses = selectedCourses;
            rebuildConflicts();
            return selectedCourses;
        },
        async syncActuallySelectedCourses() {
            if (!STATE.isGrabbing || this.isSelectedCoursesSyncing) return;
            this.isSelectedCoursesSyncing = true;
            try {
                const selectedCourses = await this.querySelectedCourses();
                UI.render();
                const selectedById = new Map(selectedCourses.map(c => [c.lessonAssoc, c]));
                const selectedIds = new Set(
                    STATE.courses
                        .filter(c => c.status !== 'success' && selectedById.has(c.lessonAssoc))
                        .map(c => c.lessonAssoc)
                );
                const successIds = new Set([
                    ...STATE.courses.filter(c => c.status === 'success').map(c => c.lessonAssoc),
                    ...selectedIds,
                ]);
                const conflictIds = new Set(
                    [...successIds]
                        .flatMap(id => STATE.courseConflicts.get(id) || [])
                        .map(c => c.lessonAssoc)
                );
                const pausedSelectedIds = new Set();
                for (const course of STATE.courses) {
                    if (
                        course.status === 'success' ||
                        course.isPaused ||
                        (!selectedIds.has(course.lessonAssoc) && !conflictIds.has(course.lessonAssoc))
                    ) continue;
                    try {
                        const status = await requestApi('/course/pause', 'POST', {lessonAssoc: course.lessonAssoc});
                        this.syncCoursesFromServer(status?.courses);
                        if (selectedIds.has(course.lessonAssoc)) pausedSelectedIds.add(course.lessonAssoc);
                    } catch (error) {
                        console.warn(`[抢课助手] 自动暂停课程 ${course.lessonAssoc} 失败:`, error.message || error);
                    }
                }

                STATE.courses = STATE.courses.map(course => {
                    if (!pausedSelectedIds.has(course.lessonAssoc)) return course;
                    STATE.toBeRemoved.add(course.lessonAssoc);
                    return {...course, ...selectedById.get(course.lessonAssoc)};
                });
                Persistence.save();
                rebuildConflicts();
                UI.render();
            } finally {
                this.isSelectedCoursesSyncing = false;
            }
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

                if (course.selectedConfirmed) {
                    STATE.toBeRemoved.add(course.lessonAssoc);
                    return {...course, status: 'success', isPaused: true};
                }

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
        handleServerError(status) {
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
        async toggleCoursePause(lessonAssoc, pause) {
            if (normalizeLessonAssoc(lessonAssoc) === null) {
                throw new Error('lessonAssoc 无效');
            }
            if (!STATE.isGrabbing) return;

            const path = pause ? '/course/pause' : '/course/resume';
            const status = await requestApi(path, 'POST', {lessonAssoc: normalizeLessonAssoc(lessonAssoc)});
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
            STATE.courses.forEach(c => {
                c.status = 'pending';
                delete c.selectedConfirmed;
            });
            await this.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc)).catch(() => {
            });
            const courses = getCoursePayload();
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
            await requestApi('/start', 'POST', payload);
            STATE.isGrabbing = true;
            this.startStatusPolling();
            UI.render();
        },
        async stop() {
            const stopResult = await requestApi('/stop', 'POST', {}).catch(() => ({}));
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
            rebuildConflicts();
            UI.render();
        },
        async fetchAndRefreshCourseGrabStatus() {
            let status = await requestApi('/status', 'GET');
            this.syncCoursesFromServer(status?.courses);
            if (this.handleServerError(status)) {
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
            this.fetchAndRefreshCourseGrabStatus().catch(error => {
                console.error('[抢课助手] 获取服务端状态失败:', error.message || error);
            });
            this.syncActuallySelectedCourses().catch(error => {
                console.warn('[抢课助手] 已选课程同步失败:', error.message || error);
            });
            STATE.statusIntervalId = setInterval(() => {
                this.fetchAndRefreshCourseGrabStatus().catch(error => {
                    console.error('[抢课助手] 获取服务端状态失败:', error.message || error);
                });
            }, 1000);
            STATE.selectedCoursesIntervalId = setInterval(() => {
                this.syncActuallySelectedCourses().catch(error => {
                    console.warn('[抢课助手] 已选课程同步失败:', error.message || error);
                });
            }, 5000);
        },
        stopStatusPolling() {
            if (STATE.statusIntervalId) {
                clearInterval(STATE.statusIntervalId);
                STATE.statusIntervalId = null;
            }
            if (STATE.selectedCoursesIntervalId) {
                clearInterval(STATE.selectedCoursesIntervalId);
                STATE.selectedCoursesIntervalId = null;
            }
        },
    };

    function init() {
        console.log('[抢课助手] 脚本已启动 ');
        watchDialog();
        Persistence.load();
        let uiMounted = false;
        const runInitialCourseSync = () => {
            if (uiMounted && STATE.courses.length > 0 && STATE.studentId && STATE.turnId && Object.keys(STATE.headers).length > 0) {
                ExecutionEngine.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc)).catch(err => console.warn('[抢课助手] 初始化课程详情同步失败:', err.message || err));
            }
        };
        const mountUi = async () => {
            await ExecutionEngine.querySelectedCourses().catch(err => console.warn('[抢课助手] 初始化课表同步失败:', err.message || err));
            rebuildConflicts();
            UI.createPanel();
            uiMounted = true;
            UI.render();
            runInitialCourseSync();
            showFirstRunNotice();
            requestApi('/status', 'GET').then((status) => {
                STATE.isGrabbing = Boolean(status?.running);
                STATE.rps = Number(status?.rps || 0);
                STATE.workers = Number(status?.workers || 0);
                ExecutionEngine.syncCoursesFromServer(status?.courses);
                if (ExecutionEngine.handleServerError(status)) {
                    STATE.isGrabbing = false;
                }
                if (STATE.isGrabbing) {
                    ExecutionEngine.startStatusPolling();
                }
                UI.render();
            }).catch(() => {
            });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountUi);
        } else {
            mountUi();
        }
        XHRInterceptor.init();
        runInitialCourseSync();
    }

    init();

})();
