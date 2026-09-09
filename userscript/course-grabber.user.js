// ==UserScript==
// @name         复旦选课助手
// @namespace    https://github.com/LinearSakana/fudan-xk-automation
// @version      0.3.3
// @description  复旦大学本科生选课助手，使用前请确保已启动本地 Server
// @author       LinearSakana
// @match        *://xk.fudan.edu.cn/*
// @icon         https://id.fudan.edu.cn/ac/favicon.ico
// @grant        none
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/gh/LinearSakana/fudan-xk-automation@main/userscript/course-grabber-ui.js?v=0.1
// @updateURL    https://cdn.jsdelivr.net/gh/LinearSakana/fudan-xk-automation@main/userscript/course-grabber.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/LinearSakana/fudan-xk-automation@main/userscript/course-grabber.user.js
// ==/UserScript==

(function () {
    'use strict';

    const UI_ASSETS = globalThis.CourseGrabberUIAssets;
    if (!UI_ASSETS) throw new Error('UI配置文件加载失败');

    // --- 全局配置 ---
    const SERVER_BASE_URL = 'http://127.0.0.1:30522';
    const STORAGE_KEY = 'fudan_course_grabber_state';
    const FIRST_RUN_NOTICE_KEY = 'first_run_notice_v2';
    const STATE = {
        courses: [], // status: 'pending' | 'paused' | 'success' | 'selected'; removeAfterStop is an independent server instruction.
        selectedCourses: [],
        courseConflicts: new Map(), // lessonAssoc -> Array<{ lessonAssoc, lessonNameZh }>
        studentId: '',
        turnId: '',
        headers: {}, // 从原始请求中捕获的全局 HTTP 头
        isGrabbing: false,
        skipCaptcha: false, // 是否跳过验证码
        isImporting: false,
        concurrency: 2, // 每门课并发实例数量
        rps: 0,
        workers: 0,
        serverErrorNoticeKey: '',
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
                const resultText = result?.textContent.trim() || '';
                if (resultText !== '可选人数已满，请有余量后再选' && !resultText.includes('与已选课程时间冲突')) return;

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

    function normalizeLessonDetails(lesson) {
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

    function isCourseSuccessful(course) {
        return course.status === 'success' || course.status === 'selected';
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
                isPaused: course.status === 'paused',
            });
        });
        return courses;
    }

    async function requestApi(path, method = 'GET', payload = null, options = {}) {
        const {
            baseUrl = SERVER_BASE_URL,
            headers = {},
        } = options;
        const url = `${baseUrl}${path}`;
        const hasBody = payload != null && method !== 'GET' && method !== 'HEAD';
        const response = await fetch(url, {
            method,
            headers: {...(hasBody ? {'Content-Type': 'application/json'} : {}), ...headers},
            body: hasBody ? JSON.stringify(payload) : undefined,
        });
        let parsed;
        try {
            parsed = await response.json();
        } catch (cause) {
            const error = new Error(`API 返回了无效 JSON - ${method} ${url} - HTTP ${response.status}`, {cause});
            error.name = 'ProtocolError';
            error.status = response.status;
            throw error;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const error = new Error(`API 响应必须是 JSON 对象 - ${method} ${url} - HTTP ${response.status}`);
            error.name = 'ProtocolError';
            error.status = response.status;
            throw error;
        }
        if (!response.ok) {
            const serverMessage = parsed?.error || parsed?.message;
            const message = [
                serverMessage || 'API request failed',
                `${method} ${url}`,
                `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
            ].join(' - ');
            const error = new Error(message);
            error.status = response.status;
            error.statusText = response.statusText;
            error.data = parsed;
            error.method = method;
            error.url = url;
            throw error;
        }
        return parsed;
    }

    function showFirstRunNotice() {
        if (localStorage.getItem(FIRST_RUN_NOTICE_KEY)) return;

        const overlay = document.createElement('div');
        overlay.id = 'grabber-first-run-notice';

        overlay.innerHTML = UI_ASSETS.firstRunNotice;

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
            UI.elements['timetable-btn'].setAttribute('aria-expanded', 'true');
            this.panel.querySelector('[data-action="close"]').focus();
            await this.refresh();
        },
        create() {
            const panel = document.createElement('div');
            panel.id = 'grabber-timetable';
            panel.hidden = true;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', '课程表');
            panel.innerHTML = UI_ASSETS.timetable;
            document.body.appendChild(panel);
            this.panel = panel;
            UI.makeDraggable(panel, panel.querySelector('.grabber-header'));
            panel.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refresh());
            const close = () => {
                panel.hidden = true;
                UI.hideHoverCard();
                UI.elements['timetable-btn'].setAttribute('aria-expanded', 'false');
                UI.elements['timetable-btn'].focus();
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
                    throw new Error('请先手动点一次选课，捕获状态后再刷新课表');
                }
                const studentId = STATE.studentId, turnId = STATE.turnId, headers = STATE.headers;
                const selected = await ExecutionEngine.refreshSelectedCourses();
                if (studentId !== STATE.studentId || turnId !== STATE.turnId || headers !== STATE.headers) {
                    throw new Error('状态已变更，请重新捕获状态后再刷新课表');
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
                if (error.status === 401) {
                    alert('未登录或状态已过期，请重置状态后再试');
                }
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
                return UI_ASSETS.timetableDay(day, blocks, this.courses, this.conflicts, WEEKDAY_LABELS, row, escapeHtml);
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
        elements: {},
        courseListEl: null,
        hoverCardEl: null,
        hoverTriggerEl: null,
        hoverCourseIndex: -1,
        lastCourseMarkup: null,
        updateConcurrencyTooltip() {
            const slider = this.elements['concurrency-slider'];
            if (!slider) return;
            const progress = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
            slider.parentElement.style.setProperty('--range-progress', progress);
            this.elements['concurrency-value'].textContent = slider.value;
        },
        createPanel() {
            if (document.getElementById('grabber-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'grabber-panel';
            panel.setAttribute('role', 'region');
            panel.setAttribute('aria-label', '选课助手');
            panel.innerHTML = UI_ASSETS.panel;
            document.body.appendChild(panel);
            this.panel = panel;
            this.elements = Object.fromEntries(Array.from(panel.querySelectorAll('[id]'), element => [element.id, element]));
            this.courseListEl = this.elements['course-list'];
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
            const styles = UI_ASSETS.styles;
            const styleSheet = document.createElement("style");
            styleSheet.innerText = styles;
            document.head.appendChild(styleSheet);
        },
        buildCourseHoverCard(course, conflicts = STATE.courseConflicts.get(Number(course.lessonAssoc)) || [], timetable = false) {
            return UI_ASSETS.courseHoverCard(course, conflicts, timetable, escapeHtml, uniqueNonEmpty);
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
            this.hoverCardEl.classList.toggle('hover-timetable', timetable);
            this.hoverCardEl.innerHTML = this.buildCourseHoverCard(course, conflicts, timetable);
            this.hoverCourseIndex = index;
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
            this.renderSession();
            this.renderMetrics();
            this.renderCourses();
            this.renderControls();
        },
        renderSession() {
            const studentIdEl = this.elements['header-student-id'];
            const studentIdText = STATE.studentId ? STATE.studentId : '未捕获';
            if (studentIdEl) {
                if (STATE.courses.some(course => ExecutionEngine.isCourseInfoIncomplete(course))) {
                    studentIdEl.textContent = '课程信息待补全';
                } else {
                    studentIdEl.textContent = 'ID: ' + studentIdText;
                }
                studentIdEl.style.display = STATE.studentId ? 'inline-block' : 'none';
            }
            const resetBtn = this.elements['reset-btn'];
            if (resetBtn) {
                resetBtn.classList.toggle('important-hint', STATE.courses.some(course => ExecutionEngine.isCourseInfoIncomplete(course)));
            }
            const skipCaptchaEl = this.elements['skip-captcha-checkbox'];
            if (skipCaptchaEl && skipCaptchaEl.checked !== STATE.skipCaptcha) {
                skipCaptchaEl.checked = STATE.skipCaptcha;
            }

            const concurrencySlider = this.elements['concurrency-slider'];
            if (concurrencySlider && concurrencySlider.value !== STATE.concurrency.toString()) {
                concurrencySlider.value = STATE.concurrency.toString();
            }

            this.updateConcurrencyTooltip();

        },
        renderMetrics() {
            const rpsText = STATE.rps.toString();
            const rpsEl = this.elements['rps-value'];
            if (rpsEl && rpsEl.textContent !== rpsText) {
                rpsEl.textContent = rpsText;
            }
            const workersEl = this.elements['workers-value'];
            const workersText = STATE.workers.toString();
            if (workersEl && workersEl.textContent !== workersText) {
                workersEl.textContent = workersText;
            }

        },
        renderCourses() {
            const markup = STATE.courses.map((course, index) => {
                const classes = [
                    STATE.courseConflicts.get(Number(course.lessonAssoc))?.length ? 'course-conflict' : '',
                    course.status === 'paused' && STATE.isGrabbing ? 'course-paused' : '',
                ].filter(Boolean).join(' ');
                // Keep the UI resource contract compatible with the existing remote asset.
                const view = {...course, status: isCourseSuccessful(course) ? 'success' : 'pending', isPaused: course.status === 'paused'};
                return `<li data-index="${index}" class="${classes}">${UI_ASSETS.courseListItem(view, index, STATE.isGrabbing, escapeHtml)}</li>`;
            }).join('');
            // Preserve focused buttons, hover and native dragging on metric-only updates.
            if (this.lastCourseMarkup !== markup) {
                this.courseListEl.innerHTML = markup;
                this.lastCourseMarkup = markup;
                this.hideHoverCard();
            }

        },
        renderControls() {
            const resetBtn = this.elements['reset-btn'];
            const grabBtn = this.elements['grab-btn'];
            const importBtn = this.elements['import-btn'];
            const clearBtn = this.elements['clear-btn'];

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
            grabBtn.disabled = ExecutionEngine.isCommandPending;
            if (ExecutionEngine.isCommandPending) {
                importBtn.disabled = resetBtn.disabled = clearBtn.disabled = true;
            }
            importBtn.textContent = STATE.isImporting ? '正在导入...' : '导入页面';
        },
        addEventListeners() {
            this.elements['timetable-btn'].addEventListener('click', () => Timetable.open());

            let draggingIndex = null;
            const clearDragIndicators = () => {
                this.courseListEl.querySelectorAll(
                    '.course-dragging, .course-drag-over-before, .course-drag-over-after'
                ).forEach(el => {
                    el.classList.remove(
                        'course-dragging',
                        'course-drag-over-before',
                        'course-drag-over-after'
                    );
                });
            };
            this.courseListEl.addEventListener('dragstart', (e) => {
                const handle = e.target.closest('.course-drag-handle');
                const li = handle?.closest('li[data-index]');
                if (!li || STATE.isGrabbing) {
                    e.preventDefault();
                    return;
                }

                draggingIndex = Number(li.dataset.index);
                li.classList.add('course-dragging');
                this.hideHoverCard();

                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(draggingIndex));
                }
            });
            this.courseListEl.addEventListener('dragover', (e) => {
                if (draggingIndex === null || STATE.isGrabbing) return;

                const li = e.target.closest('li[data-index]');
                if (!li || !this.courseListEl.contains(li)) return;

                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

                this.courseListEl.querySelectorAll(
                    '.course-drag-over-before, .course-drag-over-after'
                ).forEach(el => {
                    el.classList.remove('course-drag-over-before', 'course-drag-over-after');
                });

                const rect = li.getBoundingClientRect();
                li.classList.add(
                    e.clientY < rect.top + rect.height / 2
                        ? 'course-drag-over-before'
                        : 'course-drag-over-after'
                );
            });

            this.courseListEl.addEventListener('drop', (e) => {
                if (draggingIndex === null || STATE.isGrabbing) return;

                const li = e.target.closest('li[data-index]');
                if (!li || !this.courseListEl.contains(li)) return;

                e.preventDefault();

                const targetIndex = Number(li.dataset.index);
                const rect = li.getBoundingClientRect();
                let insertIndex = targetIndex +
                    (e.clientY >= rect.top + rect.height / 2 ? 1 : 0);

                const fromIndex = draggingIndex;

                if (fromIndex < insertIndex) {
                    insertIndex--;
                }

                if (fromIndex !== insertIndex) {
                    CourseStore.move(fromIndex, insertIndex);
                }

                draggingIndex = null;
                clearDragIndicators();
            });
            this.courseListEl.addEventListener('dragend', () => {
                draggingIndex = null;
                clearDragIndicators();
            });
            this.courseListEl.addEventListener('click', async (e) => {
                const target = e.target.closest('button');
                if (!target) return;
                const index = parseInt(target.dataset.index, 10);
                if (Number.isNaN(index) || index < 0 || index >= STATE.courses.length) return;
                const course = STATE.courses[index];
                if (!course) return;

                if (STATE.isGrabbing) {
                    if (target.dataset.action !== 'toggle-pause' || isCourseSuccessful(course)) return;
                    try {
                        await ExecutionEngine.runCommand(() => ExecutionEngine.toggleCoursePause(course.lessonAssoc, course.status !== 'paused'));
                    } catch (error) {
                        alert(`课程状态切换失败: ${error.message || error}`);
                    }
                    return;
                }

                if (target.dataset.action === 'delete') {
                    CourseStore.remove(index);
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

            const grabBtn = this.elements['grab-btn'];
            grabBtn.addEventListener('mouseenter', () => {
                if (![...STATE.courseConflicts.values()].some(conflicts => conflicts.length > 0)) {
                    this.hideHoverCard();
                    return;
                }
                const rect = grabBtn.getBoundingClientRect();
                this.hoverCardEl.innerHTML = UI_ASSETS.conflictHint;
                this.hoverCardEl.classList.add('show');
                this.hoverCardEl.setAttribute('aria-hidden', 'false');
                this.positionHoverCard(rect.right, rect.top);
            });
            grabBtn.addEventListener('mouseleave', () => this.hideHoverCard());
            grabBtn.addEventListener('click', async () => {
                try {
                    if (STATE.isGrabbing) {
                        await ExecutionEngine.runCommand(() => ExecutionEngine.stop());
                    } else {
                        await ExecutionEngine.runCommand(() => ExecutionEngine.start());
                    }
                } catch (error) {
                    alert(`请求本地服务失败: ${error.message || error}`);
                }
            });

            this.elements['skip-captcha-checkbox'].addEventListener('change', (e) => {
                SettingsStore.update({skipCaptcha: e.target.checked});
            });
            this.elements['concurrency-slider'].addEventListener('input', (e) => {
                SettingsStore.update({concurrency: e.target.value});
            });
            this.elements['clear-btn'].addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                if (confirm('确定要清空所有意向课程吗？')) {
                    CourseStore.replace([]);
                }
            });
            this.elements['reset-btn'].addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                SessionStore.reset();
                console.log('[抢课助手] 上下文信息已重置 ');
            });
            this.elements['import-btn'].addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                SettingsStore.update({isImporting: true});
                alert('导入模式已开启！请在选课页面进行一次翻页或筛选操作，脚本即自动捕获当前页所有课程 ');
            });
        }
    };

    // Course mutations own conflict rebuilding, persistence and notification.
    const CourseStore = {
        replace(courses) {
            STATE.courses = courses;
            rebuildConflicts();
            Persistence.save();
            UI.render();
        },
        setSelected(courses) {
            STATE.selectedCourses = courses;
            rebuildConflicts();
            UI.render();
        },
        add(ids) {
            const seen = new Set(STATE.courses.map(course => course.lessonAssoc));
            const added = [];
            for (const id of ids) {
                const lessonAssoc = normalizeLessonAssoc(id);
                if (lessonAssoc === null || seen.has(lessonAssoc)) continue;
                seen.add(lessonAssoc);
                added.push({lessonAssoc, status: 'pending', removeAfterStop: false});
            }
            if (added.length) this.replace([...STATE.courses, ...added]);
            return added.length;
        },
        remove(index) {
            this.replace(STATE.courses.filter((_, courseIndex) => courseIndex !== index));
        },
        move(from, to) {
            const courses = [...STATE.courses];
            const [course] = courses.splice(from, 1);
            courses.splice(to, 0, course);
            this.replace(courses);
        },
        updateDetails(infos) {
            const byId = new Map(infos.map(info => [info.lessonAssoc, info]));
            if (STATE.courses.some(course => byId.has(course.lessonAssoc))) {
                this.replace(STATE.courses.map(course => ({...course, ...byId.get(course.lessonAssoc)})));
            }
        },
    };

    const SettingsStore = {
        update(settings) {
            if ('skipCaptcha' in settings) STATE.skipCaptcha = Boolean(settings.skipCaptcha);
            if ('concurrency' in settings) STATE.concurrency = normalizeConcurrency(settings.concurrency);
            if ('isImporting' in settings) STATE.isImporting = Boolean(settings.isImporting);
            Persistence.save();
            UI.render();
        },
    };

    // Session headers and identifiers are replaced together; header identity invalidates old requests.
    const SessionStore = {
        capture(studentId, turnId, headers) {
            if (studentId == null || turnId == null) throw new Error('选课请求缺少会话信息');
            const nextStudentId = String(studentId), nextTurnId = String(turnId);
            if (STATE.studentId !== nextStudentId || STATE.turnId !== nextTurnId) {
                CourseStore.setSelected([]);
            }
            STATE.studentId = nextStudentId;
            STATE.turnId = nextTurnId;
            STATE.headers = Object.fromEntries(Object.entries(headers)
                .filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
            Persistence.save();
        },
        reset() {
            STATE.studentId = '';
            STATE.turnId = '';
            STATE.headers = {};
            CourseStore.setSelected([]);
            STATE.rps = 0;
            STATE.workers = 0;
            rebuildConflicts();
            Persistence.save();
            UI.render();
        },
    };

    // --- 数据持久化 ---
    const Persistence = {
        save() {
            const dataToSave = {
                version: 1,
                courses: STATE.courses,
                studentId: STATE.studentId,
                turnId: STATE.turnId,
                headers: STATE.headers,
                skipCaptcha: STATE.skipCaptcha,
                concurrency: STATE.concurrency,
            };
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
            } catch (error) {
                console.warn('[抢课助手] 保存状态失败:', error.message || error);
            }
        },
        load() {
            try {
                const savedState = localStorage.getItem(STORAGE_KEY);
                if (!savedState) return;
                const parsed = JSON.parse(savedState);
                // Unversioned storage is the original format; keep it readable.
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                    || (parsed.version != null && parsed.version !== 1)
                    || !Array.isArray(parsed.courses)) {
                    throw new Error('保存的状态格式无效或版本不受支持');
                }
                const seen = new Set();
                const courses = parsed.courses.filter(course => course && typeof course === 'object').map(course => {
                    const lessonAssoc = normalizeLessonAssoc(course.lessonAssoc);
                    if (lessonAssoc === null || seen.has(lessonAssoc)) return null;
                    seen.add(lessonAssoc);
                    const {isPaused, selectedConfirmed, ...details} = course;
                    return {
                        ...details,
                        lessonAssoc,
                        status: course.status === 'paused' || course.isPaused === true ? 'paused' : 'pending',
                        removeAfterStop: false,
                        teacherNames: Array.isArray(course.teacherNames) ? course.teacherNames.filter(name => typeof name === 'string') : [],
                        schedule: Array.isArray(course.schedule) ? course.schedule.filter(item => item && typeof item === 'object') : [],
                        scheduleSummary: Array.isArray(course.scheduleSummary) ? course.scheduleSummary.filter(item => typeof item === 'string') : [],
                    };
                }).filter(Boolean);
                STATE.courses = courses;
                STATE.studentId = String(parsed.studentId ?? '');
                STATE.turnId = String(parsed.turnId ?? '');
                STATE.headers = parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers)
                    ? Object.fromEntries(Object.entries(parsed.headers).filter(([, value]) => typeof value === 'string')) : {};
                STATE.skipCaptcha = parsed.skipCaptcha === true;
                STATE.concurrency = normalizeConcurrency(parsed.concurrency);
            } catch (error) {
                console.warn('[抢课助手] 无法恢复保存的状态，使用默认状态:', error.message || error);
            }
        }
    };

    // --- Captured request actions ---
    const CapturedRequests = {
        manualSelect(payload, headers) {
            const lessonAssoc = normalizeLessonAssoc(payload?.requestMiddleDtos?.[0]?.lessonAssoc);
            if (lessonAssoc === null) return;
            SessionStore.capture(payload.studentAssoc, payload.courseSelectTurnAssoc, headers);
            CourseStore.add([lessonAssoc]);
            ExecutionEngine.refreshMissingCourseDetails();
            UI.render();
        },
        importLessons(ids) {
            if (!STATE.isImporting) return;
            const importedCount = CourseStore.add(ids);
            console.log(`[抢课助手] 导入 ${importedCount} 门新课程`);
            SettingsStore.update({isImporting: false});
            ExecutionEngine.refreshMissingCourseDetails();
            UI.render();
        },
    };

    // --- XHR observation: bookkeeping stays off the page's XHR instances. ---
    const XHRInterceptor = {
        uninstall: null,
        init() {
            if (this.uninstall) return;
            const prototype = XMLHttpRequest.prototype;
            const originals = {open: prototype.open, send: prototype.send, setRequestHeader: prototype.setRequestHeader};
            const requests = new WeakMap();
            const wrappers = {
                open(method, url) {
                    const result = originals.open.apply(this, arguments);
                    requests.set(this, {url, headers: {}});
                    return result;
                },
                setRequestHeader(name, value) {
                    const result = originals.setRequestHeader.apply(this, arguments);
                    const request = requests.get(this);
                    if (request) {
                        const key = String(name).toLowerCase();
                        request.headers[key] = key in request.headers ? `${request.headers[key]}, ${value}` : String(value);
                    }
                    return result;
                },
                send(body) {
                    const request = requests.get(this);
                    if (request) {
                        try {
                            const url = new URL(request.url, window.location.origin);
                            if (url.pathname.includes('/api/v1/student/course-select/add-predicate')) {
                                CapturedRequests.manualSelect(JSON.parse(body), request.headers);
                            } else if (url.pathname.includes('/api/v1/student/course-select/std-count')) {
                                const ids = url.searchParams.get('lessonIds');
                                if (ids) CapturedRequests.importLessons(ids.split(','));
                            }
                        } catch (error) {
                            console.warn('[抢课助手] 无法处理捕获的请求:', error.message || error);
                        }
                    }
                    return originals.send.apply(this, arguments);
                },
            };
            Object.assign(prototype, wrappers);
            this.uninstall = () => {
                for (const name of Object.keys(originals)) {
                    if (prototype[name] === wrappers[name]) prototype[name] = originals[name];
                }
                this.uninstall = null;
            };
        },
    };
    // --- 抢课执行引擎 ---
    const ExecutionEngine = {
        pollGeneration: 0,
        pollTimers: new Set(),
        serverStatusRevision: 0,
        isCommandPending: false,
        async runCommand(command) {
            if (this.isCommandPending) return;
            this.isCommandPending = true;
            UI.render();
            try {
                return await command();
            } finally {
                this.isCommandPending = false;
                UI.render();
            }
        },
        isCourseInfoIncomplete(course) {
            return !course.courseName || !Array.isArray(course.teacherNames) || course.teacherNames.length === 0;
        },
        async refreshMissingCourseDetails() {
            const ids = STATE.courses.filter(course => this.isCourseInfoIncomplete(course)).map(course => course.lessonAssoc);
            if (!ids.length) return;
            try {
                await this.syncCourseDetails(ids);
            } catch (error) {
                console.warn('[抢课助手] 课程详情同步失败:', error.message || error);
            }
        },
        async queryLessonDetails(lessonAssocs) {
            const normalizedIds = [...new Set((lessonAssocs || []).map(normalizeLessonAssoc).filter(id => id !== null))];
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
            const parsed = await requestApi(queryUrl, 'POST', payload, {
                baseUrl: '',
                headers: {...STATE.headers},
            });
            const lessons = parsed?.data?.lessons;
            if (parsed.result !== 0 || !Array.isArray(lessons)) return [];
            return lessons.map(lesson => normalizeLessonDetails(lesson));
        },
        async syncCourseDetails(lessonAssocs) {
            const headers = STATE.headers;
            const [infos] = await Promise.all([
                this.queryLessonDetails(lessonAssocs),
                this.refreshSelectedCourses().catch(error => console.warn('[抢课助手] 冲突检查课表同步失败:', error.message || error)),
            ]);
            if (STATE.headers !== headers) return [];
            CourseStore.updateDetails(infos);
            return infos;
        },
        async fetchSelectedCourses() {
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) return [];
            const queryUrl = `/api/v1/student/course-select/selected-lessons/${encodeURIComponent(STATE.turnId)}/${encodeURIComponent(STATE.studentId)}`;
            const parsed = await requestApi(queryUrl, 'GET', null, {
                baseUrl: '',
                headers: {...STATE.headers},
            });
            if (parsed?.result !== 0 || !Array.isArray(parsed?.data)) {
                throw new Error(parsed?.message || '已选课程响应格式无效');
            }
            const selectedCourses = parsed.data.map(lesson => ({
                ...normalizeLessonDetails(lesson),
                status: 'selected',
                removeAfterStop: true,
            }));
            return selectedCourses;
        },
        async refreshSelectedCourses() {
            const headers = STATE.headers;
            const selectedCourses = await this.fetchSelectedCourses();
            if (STATE.headers !== headers) throw new Error('会话已变更，忽略旧课表');
            CourseStore.setSelected(selectedCourses);
            return selectedCourses;
        },
        async syncSelectedCourses(generation = this.pollGeneration) {
            if (!STATE.isGrabbing || this.isSelectedCoursesSyncing) return;
            this.isSelectedCoursesSyncing = true;
            const headers = STATE.headers;
            const isCurrent = () => generation === this.pollGeneration && STATE.isGrabbing && STATE.headers === headers;
            try {
                const selectedCourses = await this.refreshSelectedCourses();
                if (!isCurrent()) return;
                const selectedById = new Map(selectedCourses.map(c => [c.lessonAssoc, c]));
                const selectedIds = new Set(
                    STATE.courses
                        .filter(c => !isCourseSuccessful(c) && selectedById.has(c.lessonAssoc))
                        .map(c => c.lessonAssoc)
                );
                const successIds = new Set([
                    ...STATE.courses.filter(c => isCourseSuccessful(c)).map(c => c.lessonAssoc),
                    ...selectedIds,
                ]);
                const conflictIds = new Set(
                    [...successIds]
                        .flatMap(id => STATE.courseConflicts.get(id) || [])
                        .map(c => c.lessonAssoc)
                );
                const confirmedSelectedIds = new Set();
                for (const course of STATE.courses) {
                    if (
                        isCourseSuccessful(course) ||
                        (course.status === 'paused' && !selectedIds.has(course.lessonAssoc)) ||
                        (!selectedIds.has(course.lessonAssoc) && !conflictIds.has(course.lessonAssoc))
                    ) continue;
                    try {
                        if (!isCurrent()) return;
                        this.serverStatusRevision++;
                        const status = await requestApi('/course/pause', 'POST', {lessonAssoc: course.lessonAssoc});
                        this.serverStatusRevision++;
                        if (!isCurrent()) return;
                        this.syncCoursesFromServer(status?.courses);
                        if (selectedIds.has(course.lessonAssoc)) confirmedSelectedIds.add(course.lessonAssoc);
                    } catch (error) {
                        console.warn(`[抢课助手] 自动暂停课程 ${course.lessonAssoc} 失败:`, error.message || error);
                    }
                }

                if (!isCurrent()) return;
                CourseStore.replace(STATE.courses.map(course => {
                    if (!confirmedSelectedIds.has(course.lessonAssoc)) return course;
                    return {...course, ...selectedById.get(course.lessonAssoc)};
                }));
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
            const courses = STATE.courses.map((course) => {
                const serverCourse = byId.get(course.lessonAssoc);
                if (!serverCourse) return course;

                // A website-confirmed selection cannot be downgraded by the local server.
                if (course.status === 'selected') return course;
                const nextCourse = {
                    ...course,
                    status: serverCourse.status === 'success' ? 'success'
                        : serverCourse.status === 'paused' ? 'paused' : 'pending',
                    removeAfterStop: Boolean(serverCourse.markedForRemoval),
                };
                if (nextCourse.status !== course.status || nextCourse.removeAfterStop !== course.removeAfterStop) {
                    changed = true;
                }
                return nextCourse;
            });

            if (changed) CourseStore.replace(courses);
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
            this.stopPolling();
            return true;
        },
        async toggleCoursePause(lessonAssoc, pause) {
            if (normalizeLessonAssoc(lessonAssoc) === null) {
                throw new Error('lessonAssoc 无效');
            }
            if (!STATE.isGrabbing) return;

            const generation = this.pollGeneration;
            this.serverStatusRevision++;
            const path = pause ? '/course/pause' : '/course/resume';
            const status = await requestApi(path, 'POST', {lessonAssoc: normalizeLessonAssoc(lessonAssoc)});
            this.serverStatusRevision++;
            if (generation !== this.pollGeneration || !STATE.isGrabbing) return;
            this.syncCoursesFromServer(status?.courses);
            STATE.rps = Number(status?.rps || 0);
            STATE.workers = Number(status?.workers || 0);
            UI.render();
        },
        async start() {
            this.serverStatusRevision++;
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) {
                alert('上下文信息不完整，请先在网页上进行一次手动选课操作以自动捕获');
                return;
            }
            if (STATE.courses.length === 0) {
                alert('意向课程列表为空！');
                return;
            }

            STATE.concurrency = normalizeConcurrency(STATE.concurrency);
            CourseStore.replace(STATE.courses.map(course => ({
                ...course,
                status: course.status === 'paused' ? 'paused' : 'pending',
                removeAfterStop: false,
            })));
            await this.syncCourseDetails(STATE.courses.map(c => c.lessonAssoc)).catch(error => {
                console.warn('[抢课助手] 抢课前详情同步失败，继续使用已有信息:', error.message || error);
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
            this.startPolling();
            UI.render();
        },
        async stop() {
            this.stopPolling();
            let stopResult;
            try {
                stopResult = await requestApi('/stop', 'POST', {});
            } catch (error) {
                if (STATE.isGrabbing) this.startPolling();
                throw error;
            }
            STATE.isGrabbing = false;
            STATE.rps = 0;
            STATE.workers = 0;
            const removedCourses = uniqueNonEmpty(
                ((stopResult?.removedCourses || []).map(id => normalizeLessonAssoc(id)).filter(id => id !== null))
            ).map(Number);
            const removedSet = new Set([...STATE.courses.filter(course => course.removeAfterStop).map(course => course.lessonAssoc), ...removedCourses]);
            this.stopPolling();
            CourseStore.replace(STATE.courses.filter(course => !removedSet.has(course.lessonAssoc)).map(course => ({
                ...course,
                status: isCourseSuccessful(course) ? course.status : 'pending',
                removeAfterStop: false,
            })));
        },
        async pollGrabStatus(generation = this.pollGeneration) {
            const revision = this.serverStatusRevision;
            const status = await requestApi('/status', 'GET');
            if (generation !== this.pollGeneration || revision !== this.serverStatusRevision) return;
            this.syncCoursesFromServer(status?.courses);
            if (this.handleServerError(status)) {
                UI.render();
                return;
            }
            STATE.rps = Number(status?.rps || 0);
            STATE.workers = Number(status?.workers || 0);
            if (STATE.isGrabbing && status?.running === false) {
                STATE.isGrabbing = false;
                this.stopPolling();
            }
            UI.render();
        },
        startPolling() {
            this.stopPolling();
            const generation = this.pollGeneration;
            const poll = async (method, delay, label) => {
                try {
                    await this[method](generation);
                } catch (error) {
                    if (generation === this.pollGeneration) console.warn(`[抢课助手] ${label}:`, error.message || error);
                } finally {
                    if (generation === this.pollGeneration && STATE.isGrabbing) {
                        const timer = setTimeout(() => {
                            this.pollTimers.delete(timer);
                            poll(method, delay, label);
                        }, delay);
                        this.pollTimers.add(timer);
                    }
                }
            };
            poll('pollGrabStatus', 1000, '获取服务端状态失败');
            poll('syncSelectedCourses', 5000, '已选课程同步失败');
        },
        stopPolling() {
            this.pollGeneration++;
            this.serverStatusRevision++;
            this.pollTimers.forEach(timer => clearTimeout(timer));
            this.pollTimers.clear();
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
            rebuildConflicts();
            UI.createPanel();
            uiMounted = true;
            UI.render();
            if (STATE.courses.length) {
                runInitialCourseSync();
            } else {
                ExecutionEngine.refreshSelectedCourses().then(() => UI.render())
                    .catch(err => console.warn('[抢课助手] 初始化课表同步失败:', err.message || err));
            }
            showFirstRunNotice();
            const revision = ExecutionEngine.serverStatusRevision;
            requestApi('/status', 'GET').then((status) => {
                if (revision !== ExecutionEngine.serverStatusRevision) return;
                STATE.isGrabbing = Boolean(status?.running);
                STATE.rps = Number(status?.rps || 0);
                STATE.workers = Number(status?.workers || 0);
                ExecutionEngine.syncCoursesFromServer(status?.courses);
                if (ExecutionEngine.handleServerError(status)) {
                    STATE.isGrabbing = false;
                }
                if (STATE.isGrabbing) {
                    ExecutionEngine.startPolling();
                }
                UI.render();
            }).catch(error => {
                console.warn('[抢课助手] 无法连接本地服务:', error.message || error);
            });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountUi);
        } else {
            mountUi();
        }
        XHRInterceptor.init();
    }

    init();

})();
