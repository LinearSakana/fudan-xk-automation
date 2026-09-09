// UI resources loaded by course-grabber.user.js via @require.
(function (global) {
    'use strict';

    global.CourseGrabberUIAssets = Object.freeze({
        firstRunNotice: `
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
    `,
        timetable: `
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
            `,
        panel: `
                <div class="grabber-header">
                    <span class="grabber-title">选课助手 <button id="timetable-btn" class="grabber-icon-btn" title="打开课程表" aria-label="打开课程表" aria-expanded="false" aria-haspopup="dialog" aria-controls="grabber-timetable">🗓️</button></span>
                    <span id="header-student-id" class="header-student-id" title="StudentID" style="display: none;"></span>
                </div>
                <div class="grabber-body">
                    <div class="grabber-slider-group">
                        <label for="concurrency-slider" id="concurrency-num">并发数</label>
                        <div class="concurrency-range">
                            <input type="range" id="concurrency-slider" min="1" max="10" value="2">
                            <span id="concurrency-value" class="concurrency-tooltip" aria-hidden="true">2</span>
                        </div>
                        <div class="rps-display" title="本地服务状态">
                            <span class="grabber-metric">Req/s <span id="rps-value">0</span></span>
                            <span class="grabber-metric">Workers <span id="workers-value">0</span></span>
                        </div>
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
                    <div class="grabber-controls">
                        <label class="checkbox-label" title="跳过滑动验证码（按需设置）">
                            <input type="checkbox" id="skip-captcha-checkbox">
                            <span class="checkmark"></span>
                            跳过验证
                        </label>
                    </div>
                </div>
            `,
        styles: `
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
                .grabber-controls { display: flex; flex-wrap: wrap; justify-content: flex-start; align-items: center; gap: 6px 12px; margin-top: -4px; }
                .checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #4a5568; user-select: none; }
                .checkbox-label input { position: absolute; width: 1px; height: 1px; opacity: 0; }
                .checkbox-label input:focus-visible + .checkmark { outline: 2px solid #3182ce; outline-offset: 2px; }
                .checkmark { width: 14px; height: 14px; border: 2px solid #cbd5e0; border-radius: 4px; display: inline-block; position: relative; top: 1px; transition: all 0.2s; }
                .checkbox-label input:checked + .checkmark { background: #3182ce; border-color: #3182ce; }
                .checkbox-label input:checked + .checkmark::after { content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
                .rps-display { display: grid; box-sizing: border-box; flex: 0 0 82px; min-width: 0; overflow: hidden; padding: 3px 7px; border: 1px solid #e2e8f0; border-radius: 9px; background: linear-gradient(135deg, #f7fafc, #edf2f7); color: #718096; font-size: 11px; line-height: 16px; }
                .grabber-metric { grid-area: 1 / 1; display: flex; align-items: center; justify-content: space-between; gap: 6px; white-space: nowrap; animation: grabber-metric-cycle 6s ease-in-out infinite; }
                .grabber-metric:nth-child(2) { animation-delay: -3s; }
                #rps-value, #workers-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #2b6cb0; font-weight: 600; font-variant-numeric: tabular-nums; }
                @keyframes grabber-metric-cycle {
                    0%, 42%, 100% { opacity: 1; transform: translateY(0); }
                    50% { opacity: 0; transform: translateY(-12px); }
                    50.01%, 92% { opacity: 0; transform: translateY(12px); }
                }
                @media (prefers-reduced-motion: reduce) {
                    .grabber-metric { grid-area: auto; animation: none; }
                }
                .grabber-slider-group { display: flex; align-items: center; gap: 8px; padding: 0 0 6px; }
                #concurrency-num { flex-shrink: 0; font-size: 12px; color: #4a5568; white-space: nowrap; }
                .concurrency-range { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; height: 22px; --thumb-size: 14px; }
                #concurrency-slider { appearance: none; width: 100%; margin: 0; height: 6px; border-radius: 3px; background: #e2e8f0; cursor: pointer; }
                #concurrency-slider::-webkit-slider-thumb { appearance: none; width: var(--thumb-size); height: var(--thumb-size); border: 2px solid white; border-radius: 50%; background: #3182ce; box-shadow: 0 1px 4px rgba(43,108,176,.3); }
                #concurrency-slider::-moz-range-thumb { box-sizing: border-box; width: var(--thumb-size); height: var(--thumb-size); border: 2px solid white; border-radius: 50%; background: #3182ce; box-shadow: 0 1px 4px rgba(43,108,176,.3); }
                #concurrency-slider:focus-visible { outline: 2px solid #3182ce; outline-offset: 4px; }
                .concurrency-tooltip { position: absolute; bottom: calc(100% + 4px); left: calc(var(--range-progress, 0) * (100% - var(--thumb-size)) + var(--thumb-size) / 2); padding: 3px 7px; border-radius: 7px; background: linear-gradient(135deg, #2b6cb0, #3182ce); color: white; font-size: 11px; font-weight: 600; line-height: 16px; font-variant-numeric: tabular-nums; box-shadow: 0 3px 8px rgba(43,108,176,.2); pointer-events: none; opacity: 0; transform: translate(-50%, 4px) scale(.92); transition: opacity .16s ease, transform .16s ease; }
                .concurrency-tooltip::after { content: ''; position: absolute; top: 100%; left: 50%; margin-left: -3px; border: 3px solid transparent; border-top-color: #3182ce; }
                .concurrency-range:hover .concurrency-tooltip, #concurrency-slider:focus-visible + .concurrency-tooltip, #concurrency-slider:active + .concurrency-tooltip { opacity: 1; transform: translate(-50%, 0) scale(1); }
                @media (prefers-reduced-motion: reduce) { .concurrency-tooltip { transition: none; } }
                #course-list { list-style: none; padding: 0; margin: 0; max-height: 380px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; scrollbar-color: #cbd5e0 transparent; }
                #course-list::-webkit-scrollbar { width: 6px; }
                #course-list::-webkit-scrollbar-thumb { background-color: #cbd5e0; border-radius: 10px; }
                #course-list li { position: relative; display: flex; align-items: center; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #ffffff; transition: all 0.2s ease; }
                #course-list li:hover { transform: translateY(-1px); border-color: #cbd5e0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
                #course-list li.course-paused { background: #f7fafc; opacity: 0.7; }
                #course-list li.course-dragging { opacity: 0.4; transform: none; }
                #course-list li.course-drag-over-before::before,
                #course-list li.course-drag-over-after::after { content: ''; position: absolute; left: 6px; right: 6px; height: 2px; background: #3182ce; border-radius: 2px; pointer-events: none; }
                #course-list li.course-drag-over-before::before { top: -5px; }
                #course-list li.course-drag-over-after::after { bottom: -5px; }
                .course-drag-handle { flex-shrink: 0; margin-right: 8px; color: #a0aec0; cursor: grab; user-select: none; font-size: 16px; line-height: 1; }
                .course-drag-handle:active { cursor: grabbing; }
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
            `,

        conflictHint: '互斥课程可以正常参与抢课 <br><br> 对于每一个已抢到的课程， <br> 与之冲突的其他课程会自动暂停',
        timetableDay(day, blocks, courses, conflicts, weekdayLabels, row, escapeHtml) {
            return `<div class="timetable-day" aria-label="${weekdayLabels[day]}">
                ${Array.from({length: 14}, (_, i) => `<div class="timetable-cell" style="grid-row:${row(i + 1)}" aria-hidden="true"></div>`).join('')}
                ${blocks.map(entry => {
                const course = courses[entry.index];
                const conflict = conflicts.get(Number(course.lessonAssoc))?.length;
                const name = course.courseName || course.lessonNameZh || `Lesson ${course.lessonAssoc}`;
                const code = course.lessonCode || course.courseCode || '待同步';
                const label = `${name} ${code}，${weekdayLabels[day]} ${entry.start}~${entry.end}节，${course.timetableSelected ? '已选' : '意向'}${conflict ? '，存在冲突' : ''}`;
                return `<button class="timetable-course ${course.timetableSelected ? 'timetable-selected' : 'timetable-intended'}${conflict ? ' timetable-conflict' : ''}"
                        data-course-index="${entry.index}" aria-label="${escapeHtml(label)}"
                        style="grid-row:${row(entry.start)} / ${row(entry.end) + 1}; width:calc(${100 / entry.lanes}% - 4px); margin-left:calc(${entry.lane * 100 / entry.lanes}% + 2px)">
                        <span>${escapeHtml(name)}</span><small>${escapeHtml(code)}</small>
                    </button>`;
            }).join('')}
            </div>`;
        },
        courseHoverCard(course, conflicts, timetable, escapeHtml, uniqueNonEmpty) {
            const courseCode = course.courseCode || course.lessonCode || '待同步';
            const teacherText = Array.isArray(course.teacherNames) && course.teacherNames.length > 0
                ? course.teacherNames.join('、')
                : '待获取';
            const creditText = course.credits === null || course.credits === undefined ? '待同步' : String(course.credits);
            const campusText = course.campus || '待同步';
            const limitText = course.limitCount === null || course.limitCount === undefined ? '待同步' : String(course.limitCount);
            const remarkText = course.selectionRemark || '无';
            const scheduleDetails = Array.isArray(course.scheduleSummary) && course.scheduleSummary.length > 0
                ? course.scheduleSummary.slice(0, 4).map(item => escapeHtml(item)).join('<br>')
                : '待获取';
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
                : scheduleDetails}</div></div>
                ${conflicts.length ? `<div class="hover-conflict">⚠️ 当前课程与${conflicts.map(item => escapeHtml(item.lessonNameZh)).join('，')}存在冲突，您可根据自身情况，决定该课程的去留</div>` : ''}
                </div>
            `;
        },
        courseListItem(course, index, isGrabbing, escapeHtml) {
            const courseName = course.courseName || `LessonAssoc: ${course.lessonAssoc}`;
            const teachersText = course.teacherNames && course.teacherNames.length > 0
                ? course.teacherNames.join('、')
                : '教师信息待获取';
            let rightContent;
            if (isGrabbing) {
                const statusClass = course.status === 'success' ? 'status-success' : (course.isPaused ? 'status-paused' : 'status-running');
                const statusText = course.status === 'success' ? '成功' : (course.isPaused ? '已暂停' : '抢课中');
                const disabledAttr = course.status === 'success' ? 'disabled' : '';
                const actionLabel = course.status === 'success' ? `${courseName}：成功` : `${course.isPaused ? '继续' : '暂停'} ${courseName}`;
                rightContent = `<button class="course-status-pill ${statusClass}" data-index="${index}" data-action="toggle-pause" title="${escapeHtml(statusText)}" aria-label="${escapeHtml(actionLabel)}" ${disabledAttr}></button>`;
            } else {
                rightContent = `<div class="course-actions"><button data-index="${index}" data-action="delete" title="删除" aria-label="删除 ${escapeHtml(courseName)}">✖</button></div>`;
            }
            return `
                ${isGrabbing ? '' : `<span class="course-drag-handle" draggable="true" title="拖动排序" aria-label="拖动 ${escapeHtml(courseName)} 排序">⋮⋮</span>`}
                <div class="course-main">
                    <div class="course-title" title="${escapeHtml(courseName)}">${escapeHtml(courseName)}</div>
                    <div class="course-teachers" title="${escapeHtml(teachersText)}">${escapeHtml(teachersText)}</div>
                </div>
                ${rightContent}
            `;
        },
    });
})(globalThis);
