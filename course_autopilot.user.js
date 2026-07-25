// ==UserScript==
// @name         Qlik Sense Course & Quiz Autopilot (Multi-Tab + Quiz Solver)
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  Automates Qlik Learning course progression, video playback at 2x speed, Gemini AI quiz solving (MCQs & Drag-Drop matching), API key ping validation, and auto-advancing lessons.
// @author       Antigravity
// @match        https://learning.qlik.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @connect      api.openai.com
// @run-at       document-end
// @allFrames    true
// ==/UserScript==

(function () {
    'use strict';

    // --------------------------------------------------
    // ONLY RUN IN TOP-LEVEL WINDOWS (Unless executing frame scanner)
    // Prevents conflicts from tracking or background iframes
    // --------------------------------------------------
    if (window !== window.top) {
        return;
    }

    // Unique ID for this tab session
    let tabId = sessionStorage.getItem('qlik_tab_id');
    if (!tabId) {
        tabId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('qlik_tab_id', tabId);
    }

    // State Constants
    const STATE = {
        IDLE: 'IDLE',
        PLAYING_VIDEO: 'PLAYING_VIDEO',
        VIDEO_FINISHED: 'VIDEO_FINISHED',
        TAKING_QUIZ: 'TAKING_QUIZ',
        NAVIGATING_NEXT: 'NAVIGATING_NEXT'
    };

    // --------------------------------------------------
    // CONFIGURATION & DEFAULTS
    // --------------------------------------------------
    const DEFAULT_CONFIG = {
        enabled: false,
        autoSolveQuiz: true,
        state: STATE.IDLE,
        playbackSpeed: 2.0,         // Target video speed (2.0x)
        quizDelay: 1500,            // Delay between quiz actions (ms)
        apiKey: '',
        aiProvider: 'gemini',       // 'gemini' | 'openai' | 'heuristic'
        checkInterval: 2500,        // ms
        videoFinishDelay: 2000,     // Delay in ms before closing tab after video ends
        noVideoTimeout: 15000,      // Delay in ms before auto-closing reading pages without videos
        videoStartTime: 0,
        lastStateTime: 0
    };

    function getSafeNumber(key, defaultValue, minVal = 0) {
        let val = GM_getValue('qlik_' + key + '_v9');
        if (val === undefined || val === null || isNaN(Number(val))) {
            return defaultValue;
        }
        return Math.max(minVal, Number(val));
    }

    let config = {
        enabled: !!GM_getValue('qlik_enabled_v9', DEFAULT_CONFIG.enabled),
        autoSolveQuiz: !!GM_getValue('qlik_autoSolveQuiz_v9', DEFAULT_CONFIG.autoSolveQuiz),
        state: GM_getValue('qlik_state_v9', DEFAULT_CONFIG.state) || STATE.IDLE,
        playbackSpeed: getSafeNumber('playbackSpeed', DEFAULT_CONFIG.playbackSpeed, 1.0),
        quizDelay: getSafeNumber('quizDelay', DEFAULT_CONFIG.quizDelay, 500),
        apiKey: GM_getValue('qlik_apiKey_v9', ''),
        aiProvider: GM_getValue('qlik_aiProvider_v9', DEFAULT_CONFIG.aiProvider),
        checkInterval: getSafeNumber('checkInterval', DEFAULT_CONFIG.checkInterval, 1000),
        videoFinishDelay: getSafeNumber('videoFinishDelay', DEFAULT_CONFIG.videoFinishDelay, 500),
        noVideoTimeout: getSafeNumber('noVideoTimeout', DEFAULT_CONFIG.noVideoTimeout, 5000),
        videoStartTime: getSafeNumber('videoStartTime', DEFAULT_CONFIG.videoStartTime, 0),
        lastStateTime: getSafeNumber('lastStateTime', DEFAULT_CONFIG.lastStateTime, 0)
    };

    let activeChildWindow = null;
    let mainLoopTimer = null;
    let logs = [];
    let currentUrlPath = window.location.pathname;

    // Quiz Session State Tracking
    let quizState = {
        lastQuestionText: '',
        processedQuestionsCount: 0,
        isSolving: false
    };

    function addLog(msg) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const logMsg = `[${time}] ${msg}`;

        let currentLogs = GM_getValue('qlik_logs_v9', []);
        if (!Array.isArray(currentLogs)) currentLogs = [];

        currentLogs.unshift(logMsg);
        if (currentLogs.length > 50) currentLogs.pop();

        GM_setValue('qlik_logs_v9', currentLogs);
        logs = currentLogs;

        updateLogUI();
        console.log(`[Qlik Autopilot] ${msg}`);
    }

    function saveConfig() {
        for (let key in config) {
            GM_setValue('qlik_' + key + '_v9', config[key]);
        }
    }

    function transitionState(newState) {
        if (config.state === newState) return; // Prevent duplicate transition log spam
        addLog(`Transitioning state: ${config.state} ➔ ${newState}`);
        config.state = newState;
        config.lastStateTime = Date.now();
        GM_setValue('qlik_state_v9', newState);
        GM_setValue('qlik_lastStateTime_v9', config.lastStateTime);
        updateStatusText(newState);
    }

    function haltAutopilotWithError(msg) {
        addLog(`❌ HALTED: ${msg}`);
        config.enabled = false;
        GM_setValue('qlik_enabled_v9', false);
        transitionState(STATE.IDLE);
        updateStatusText("⚠️ HALTED (Manual Action Required)");

        const toggleBtn = document.getElementById('qa-toggle-enabled');
        if (toggleBtn) toggleBtn.checked = false;
    }

    // --------------------------------------------------
    // CROSS-FRAME DOM UTILITIES
    // --------------------------------------------------
    function querySelectorAllCrossFrame(selector, rootDoc = document) {
        let elements = Array.from(rootDoc.querySelectorAll(selector));
        const iframes = rootDoc.querySelectorAll('iframe');
        for (let iframe of iframes) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDoc) {
                    elements = elements.concat(querySelectorAllCrossFrame(selector, iframeDoc));
                }
            } catch (e) {
                // Cross-origin restriction
            }
        }
        return elements;
    }

    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const win = el.ownerDocument.defaultView || window;
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
            return false;
        }
        let parent = el.parentElement;
        while (parent) {
            const pStyle = win.getComputedStyle(parent);
            if (pStyle.display === 'none' || pStyle.visibility === 'hidden') {
                return false;
            }
            parent = parent.parentElement;
        }
        return true;
    }

    function isInsideSidebarOrDrawer(el) {
        let parent = el.parentElement;
        while (parent) {
            const className = (parent.className || '').toString().toLowerCase();
            const id = (parent.id || '').toString().toLowerCase();
            const tagName = parent.tagName.toLowerCase();
            if (className.includes('sidebar') || className.includes('drawer') ||
                className.includes('toc') || className.includes('course-map') ||
                id.includes('sidebar') || id.includes('drawer') || id.includes('toc') ||
                tagName === 'aside') {
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    }

    function getAllIframes(doc = document) {
        let list = [];
        try {
            const iframes = doc.querySelectorAll('iframe');
            for (let iframe of iframes) {
                list.push(iframe);
                try {
                    const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
                    if (innerDoc) {
                        list = list.concat(getAllIframes(innerDoc));
                    }
                } catch (e) { }
            }
        } catch (e) { }
        return list;
    }

    function triggerClick(element) {
        if (!element) return;
        const win = element.ownerDocument ? (element.ownerDocument.defaultView || window) : window;

        if (element.disabled) {
            element.disabled = false;
            element.removeAttribute('disabled');
            element.classList.remove('disabled');
        }

        ['pointerdown', 'mouseenter', 'mouseover', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
            try {
                const evt = new (win.MouseEvent || MouseEvent)(eventType, {
                    bubbles: true,
                    cancelable: true,
                    view: win
                });
                element.dispatchEvent(evt);
            } catch (e) { }
        });

        if (element.tagName === 'INPUT' && (element.type === 'radio' || element.type === 'checkbox')) {
            element.checked = true;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // --------------------------------------------------
    // DURATION & TITLE SCRAPERS
    // --------------------------------------------------
    function getCurrentPageDuration() {
        const elements = document.querySelectorAll('div, span, p, li, td');
        for (let el of elements) {
            if (el.children.length < 3 && el.textContent) {
                const txt = el.textContent.replace(/\s+/g, ' ').trim();
                if (/Published|Beginner|Intermediate|Advanced|Learning/i.test(txt)) {
                    const match = txt.match(/\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
                    if (match) {
                        const mins = parseInt(match[1]);
                        if (mins > 0 && mins < 180) return mins;
                    }
                }
            }
        }
        return 5;
    }

    function getCurrentActivityTitle() {
        const h1 = document.querySelector('h1');
        if (h1 && isElementVisible(h1)) return h1.textContent.trim();
        const heading = document.querySelector('[class*="heading"], [class*="title"]');
        if (heading && isElementVisible(heading)) return heading.textContent.trim();
        return document.title.replace('- Qlik Learning', '').trim();
    }

    // --------------------------------------------------
    // DRAG AND DROP / MOUSE EVENT SIMULATION
    // --------------------------------------------------
    function simulateDragAndDrop(sourceEl, targetEl) {
        if (!sourceEl || !targetEl) return false;
        const doc = sourceEl.ownerDocument || document;
        const win = doc.defaultView || window;

        // 1. Try HTML5 Drag & Drop API with DataTransfer
        try {
            const dataTransfer = new (win.DataTransfer || DataTransfer)();
            dataTransfer.effectAllowed = 'all';
            dataTransfer.dropEffect = 'move';

            const dragStartEvent = new win.DragEvent('dragstart', {
                bubbles: true, cancelable: true, dataTransfer: dataTransfer
            });
            sourceEl.dispatchEvent(dragStartEvent);

            const dragEnterEvent = new win.DragEvent('dragenter', {
                bubbles: true, cancelable: true, dataTransfer: dataTransfer
            });
            targetEl.dispatchEvent(dragEnterEvent);

            const dragOverEvent = new win.DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dataTransfer
            });
            targetEl.dispatchEvent(dragOverEvent);

            const dropEvent = new win.DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dataTransfer
            });
            targetEl.dispatchEvent(dropEvent);

            const dragEndEvent = new win.DragEvent('dragend', {
                bubbles: true, cancelable: true, dataTransfer: dataTransfer
            });
            sourceEl.dispatchEvent(dragEndEvent);
        } catch (e) {
            console.error("HTML5 Drag&Drop simulation error:", e);
        }

        // 2. Pointer Event Simulation (dnd-kit, react-beautiful-dnd, etc.)
        try {
            const sourceRect = sourceEl.getBoundingClientRect();
            const targetRect = targetEl.getBoundingClientRect();
            const srcX = sourceRect.left + sourceRect.width / 2;
            const srcY = sourceRect.top + sourceRect.height / 2;
            const dstX = targetRect.left + targetRect.width / 2;
            const dstY = targetRect.top + targetRect.height / 2;

            if (win.PointerEvent) {
                sourceEl.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: srcX, clientY: srcY, pointerId: 1, isPrimary: true }));
                doc.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: dstX, clientY: dstY, pointerId: 1, isPrimary: true }));
                targetEl.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: dstX, clientY: dstY, pointerId: 1, isPrimary: true }));
                targetEl.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: dstX, clientY: dstY, pointerId: 1, isPrimary: true }));
            }

            const mousedown = new win.MouseEvent('mousedown', {
                bubbles: true, cancelable: true, clientX: srcX, clientY: srcY, buttons: 1
            });
            sourceEl.dispatchEvent(mousedown);

            const mousemove = new win.MouseEvent('mousemove', {
                bubbles: true, cancelable: true, clientX: dstX, clientY: dstY, buttons: 1
            });
            doc.dispatchEvent(mousemove);
            targetEl.dispatchEvent(mousemove);

            const mouseup = new win.MouseEvent('mouseup', {
                bubbles: true, cancelable: true, clientX: dstX, clientY: dstY, buttons: 0
            });
            targetEl.dispatchEvent(mouseup);
        } catch (e) {
            console.error("Mouse Drag simulation error:", e);
        }

        // 3. Fallback: Click source then click target (Click-to-match UI)
        try {
            triggerClick(sourceEl);
            setTimeout(() => triggerClick(targetEl), 150);
        } catch (e) { }

        return true;
    }

    // --------------------------------------------------
    // QUIZ SOLVER ENGINE
    // --------------------------------------------------

    function isQuizActivityPage() {
        const titleEl = document.querySelector('h1, h2, h3, .activity-title, [class*="title"]');
        const titleText = ((document.title || '') + ' ' + (titleEl ? titleEl.textContent : '')).toLowerCase();
        const quizRegex = /quiz|assessment|knowledge\s*check|exam|test/i;

        return quizRegex.test(titleText);
    }

    function findLaunchOrStartQuizButton() {
        if (window.location.href.includes('/assessment_responses/take') || window.location.pathname.includes('/assessment_responses/take')) {
            return null; // Already inside active assessment!
        }

        // Strictly verify that the activity title or page context indicates a QUIZ!
        if (!isQuizActivityPage()) {
            return null;
        }

        // 1. Direct ID & Class targeting for launch_assessment
        const explicitIdMatches = querySelectorAllCrossFrame('#launch_assessment, [id*="launch_assessment"], [id*="launch-assessment"], [id*="launch_quiz"], [id*="start_assessment"], .launch_assessment');
        for (let el of explicitIdMatches) {
            if (isElementVisible(el) && !isInsideSidebarOrDrawer(el)) {
                const txt = (el.textContent || el.value || '').trim().toLowerCase();
                if (txt.includes('review') || txt.includes('view responses') || txt.includes('view score')) {
                    continue; // Skip review buttons!
                }
                return el;
            }
        }

        // 2. Candidate elements by tag and attribute/text
        const candidates = querySelectorAllCrossFrame('button, a, div[role="button"], span[role="button"], input[type="button"], input[type="submit"], #launch_assessment, [id*="launch"]');
        for (let el of candidates) {
            if (!isElementVisible(el) || isInsideSidebarOrDrawer(el)) continue;
            const id = (el.id || '').toLowerCase();
            const txt = (el.textContent || el.value || '').trim().toLowerCase();

            if (txt.includes('review') || txt.includes('view responses') || txt.includes('view score')) {
                continue; // Skip review buttons!
            }

            if (id.includes('launch') || id.includes('assessment') ||
                txt.includes('launch') || txt.includes('take the quiz') || txt.includes('start quiz') ||
                txt.includes('take quiz') || txt.includes('begin quiz') || txt.includes('start assessment') ||
                txt.includes('take assessment') || txt.includes('begin') || txt.includes('continue quiz') ||
                txt === 'launch >' || txt === 'launch') {
                return el;
            }
        }

        // 3. Direct Qlik Launch button class
        const directLaunch = document.querySelector('.activityheading__continuelearningcontent, a[href*="/activity/"]');
        if (directLaunch && isElementVisible(directLaunch) && !isInsideSidebarOrDrawer(directLaunch)) {
            const txt = (directLaunch.textContent || '').trim().toLowerCase();
            if (!txt.includes('review')) return directLaunch;
        }
        return null;
    }

    function isGenericQuestionHeader(txt) {
        if (!txt) return true;
        const clean = txt.trim().toLowerCase();
        return /^question\s*\d+(\s*of\s*\d+)?$/i.test(clean) ||
            /^question\s*\d+:?$/i.test(clean) ||
            clean === 'quiz' || clean === 'assessment' ||
            clean.includes('question count') ||
            clean.includes('survey=false') ||
            clean.includes('embeds/videos') ||
            clean.includes('question 1 of');
    }

    function isQuizOverviewPage() {
        const url = window.location.href;
        if (url.includes('/assessment_responses/take')) {
            return false;
        }

        // Non-activity overview pages (URLs without /activity/ or /assessment_responses/) are always overview pages!
        if (!url.includes('/activity/') && !url.includes('/assessment_responses/')) {
            return true;
        }

        const bodyText = document.body.textContent || '';
        if (bodyText.includes('Passed (') || bodyText.includes('Completed by') || bodyText.includes('Passed on')) {
            return true;
        }

        if (findQuizReviewButton() && !findLaunchOrStartQuizButton()) {
            return true;
        }

        return false;
    }

    function findQuizQuestionElement() {
        const url = window.location.href;
        const isTakingQuizUrl = url.includes('/assessment_responses/take');

        if (!isTakingQuizUrl) {
            const isActivityUrl = url.includes('/activity/') || url.includes('/assessment_responses/');
            if (!isActivityUrl) return null;
            if (!isQuizActivityPage()) return null;
            if (isQuizOverviewPage()) return null;
        }

        const selectors = [
            '.question-text', '.question-title', '.quiz-question', '.q-text',
            '.assessment-question', '[data-purpose*="question"]', '.question',
            'h2', 'h3', 'h4', '.prompt', '.statement', '.quiz-stem', '.stem'
        ];

        for (let sel of selectors) {
            const els = querySelectorAllCrossFrame(sel);
            for (let el of els) {
                if (isElementVisible(el)) {
                    const txt = (el.textContent || '').trim();
                    if (txt.length > 5 && !isGenericQuestionHeader(txt)) {
                        return el;
                    }
                }
            }
        }

        // Fallback: search headings or bold divs containing '?' or 'Match' or 'Question'
        const headings = querySelectorAllCrossFrame('h1, h2, h3, h4, h5, div[class*="question"], div[class*="title"]');
        for (let h of headings) {
            if (isElementVisible(h)) {
                const txt = (h.textContent || '').trim();
                if (!isGenericQuestionHeader(txt) && txt.length > 8) return h;
            }
        }
        return null;
    }

    function parseQuizQuestionContext() {
        const qEl = findQuizQuestionElement();
        if (!qEl) return null;

        const questionText = (qEl.textContent || '').trim();

        // 1. Check for Radio / Checkbox MCQ Controls
        const mcqInputs = querySelectorAllCrossFrame('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').filter(isElementVisible);
        const hasMCQControls = mcqInputs.length > 0;

        // 2. Check for explicit Drag & Drop / Matching elements
        let dragSources = querySelectorAllCrossFrame('[draggable="true"], .drag-item, .draggable, .source-item, .matching-source, [data-drag], .drag-card, .match-left .item, .draggable-item, [class*="draggable"], [class*="drag-item"], [class*="source-item"]').filter(isElementVisible);
        let dropTargets = querySelectorAllCrossFrame('.drop-zone, .dropzone, [data-drop], .target-item, .matching-target, .drop-card, .match-right .item, .droppable, [class*="dropzone"], [class*="drop-zone"], [class*="target-item"]').filter(isElementVisible);

        const isMatchingInstruction = /match\s+each|match\s+the|rearrange|drag\s+and\s+drop|what\s+does\s+each\s+of\s+the\s+following\s+represent|map\s+each|associate\s+each|connect\s+each/i.test(questionText);

        // 3. Only evaluate MATCHING_DRAG_DROP if question does NOT have standard radio/checkbox controls AND has matching instructions/drag elements
        if (!hasMCQControls && (isMatchingInstruction || dragSources.length > 0 || dropTargets.length > 0)) {
            if (dragSources.length === 0 || dropTargets.length === 0) {
                const allCards = querySelectorAllCrossFrame('div[class*="card"], div[class*="choice"], div[class*="option"], div[class*="box"], div[class*="item"], div[class*="block"], div[class*="match"], li[class*="item"], div[role="button"]').filter(el => {
                    if (!isElementVisible(el)) return false;
                    const txt = (el.textContent || '').trim();
                    return txt.length > 3 && !isGenericQuestionHeader(txt) && el.querySelectorAll('div').length < 4;
                });

                const numberedLeft = allCards.filter(el => {
                    const txt = (el.textContent || '').trim();
                    return /^\d+[\.\)]\s+/.test(txt);
                });

                const unnumberedRight = allCards.filter(el => {
                    const txt = (el.textContent || '').trim();
                    return !/^\d+[\.\)]\s+/.test(txt) && !numberedLeft.includes(el);
                });

                if (numberedLeft.length > 0 && unnumberedRight.length > 0) {
                    dragSources = numberedLeft;
                    dropTargets = unnumberedRight;
                } else if (allCards.length >= 4) {
                    // Visual X-Midpoint Splitter
                    let minX = Infinity, maxX = -Infinity;
                    allCards.forEach(c => {
                        const r = c.getBoundingClientRect();
                        if (r.left < minX) minX = r.left;
                        if (r.right > maxX) maxX = r.right;
                    });

                    if (maxX - minX > 80) {
                        const midX = (minX + maxX) / 2;
                        const leftCol = allCards.filter(c => c.getBoundingClientRect().left < midX);
                        const rightCol = allCards.filter(c => c.getBoundingClientRect().left >= midX);

                        if (leftCol.length > 0 && rightCol.length > 0) {
                            dragSources = leftCol;
                            dropTargets = rightCol;
                        }
                    }
                }
            }

            if (dragSources.length > 0 && dropTargets.length > 0) {
                const sources = dragSources.map(el => ({ el, text: (el.textContent || el.value || '').trim() }));
                const targets = dropTargets.map(el => ({ el, text: (el.textContent || el.value || '').trim() }));
                const signature = `${questionText.substring(0, 80)} [Matching: ${sources.map(s => s.text).join('|')}]`;

                return {
                    type: 'MATCHING_DRAG_DROP',
                    qEl,
                    questionText,
                    sources,
                    targets,
                    signature
                };
            }
        }

        // 2. Check for Dropdown Matching (where question has <select> elements paired with items)
        const dropdowns = querySelectorAllCrossFrame('select').filter(isElementVisible);
        if (dropdowns.length > 1) {
            const dropdownPairs = dropdowns.map(sel => {
                const parent = sel.closest('tr, li, div') || sel.parentElement;
                const labelText = parent ? parent.textContent.replace(sel.textContent, '').trim() : '';
                const options = Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() }));
                return { selectEl: sel, labelText, options };
            });
            const signature = `${questionText.substring(0, 80)} [Dropdowns: ${dropdownPairs.map(p => p.labelText).join('|')}]`;

            return {
                type: 'MATCHING_DROPDOWN',
                qEl,
                questionText,
                pairs: dropdownPairs,
                signature
            };
        }

        // 3. MCQ Options (Single or Multi-select)
        const optionSelectors = [
            'label', '.choice', '.option', 'input[type="radio"]', 'input[type="checkbox"]',
            '[role="radio"]', '[role="checkbox"]', '.answer-option', '.quiz-option',
            '.item-choice', '[data-purpose*="choice"]'
        ];

        let optionEls = [];
        for (let sel of optionSelectors) {
            const els = querySelectorAllCrossFrame(sel).filter(isElementVisible);
            if (els.length > 0) {
                optionEls = els;
                break;
            }
        }

        const isMulti = /select\s*(?:all|multiple|two|three|four|five|\d+)|choose\s*(?:all|two|three|four|five|\d+)|which\s*(?:two|three|four|five|\d+)|identify\s*(?:two|three|four|five|\d+)|pick\s*(?:two|three|four|five|\d+)|which\s*of\s*the\s*following\s*are|\(\s*select\s*\d+\s*\)|\(\s*choose\s*\d+\s*\)/i.test(questionText) ||
            optionEls.some(el => el.tagName === 'INPUT' && el.type === 'checkbox') ||
            optionEls.some(el => el.getAttribute('role') === 'checkbox') ||
            optionEls.some(el => el.className && el.className.toLowerCase().includes('checkbox'));

        const options = optionEls.map(el => ({ el, text: (el.textContent || el.value || '').trim() || 'Choice' }));
        const signature = `${questionText.substring(0, 80)} [Choices: ${options.map(o => o.text).join('|')}]`;

        return {
            type: isMulti ? 'MCQ_MULTI' : 'MCQ_SINGLE',
            qEl,
            questionText,
            options,
            signature
        };
    }

    function findQuizNextOrSubmitButton() {
        const candidates = querySelectorAllCrossFrame('button, input[type="button"], input[type="submit"], a.btn, div[role="button"], span[role="button"]');
        for (let cand of candidates) {
            if (!isElementVisible(cand)) continue;
            const txt = (cand.textContent || cand.value || '').trim().toLowerCase();
            if (txt.includes('next') || txt.includes('submit') || txt.includes('check answer') ||
                txt.includes('continue') || txt.includes('finish') || txt.includes('confirm') ||
                txt.includes('submit answer') || txt.includes('next question')) {
                return cand;
            }
        }
        return null;
    }

    function parseCleanJSONResponse(rawText) {
        try {
            let cleaned = rawText.trim();
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            }
            return JSON.parse(cleaned);
        } catch (e) {
            console.error("Failed to parse AI JSON response:", rawText, e);
            return null;
        }
    }

    async function verifyAndSaveAPIKey(testKey, provider = config.aiProvider) {
        const keyInput = document.getElementById('qa-cfg-apikey');
        const statusLabel = document.getElementById('qa-key-status');
        const testBtn = document.getElementById('qa-btn-test-key');

        const setStatusUI = (status, color, border) => {
            if (statusLabel) {
                statusLabel.textContent = status;
                statusLabel.style.color = color;
            }
            if (keyInput) {
                keyInput.style.borderColor = border;
            }
        };

        if (!testKey) {
            config.apiKey = '';
            GM_setValue('qlik_apiKey_v9', '');
            setStatusUI('Not Set', '#a0a0a0', 'rgba(255, 255, 255, 0.3)');
            addLog("API Key cleared.");
            return false;
        }

        setStatusUI('Testing...', '#e6c200', '#e6c200');
        addLog(`Testing ${provider.toUpperCase()} API key access (Gemini Flash Lite)...`);
        if (testBtn) testBtn.disabled = true;

        return new Promise((resolve) => {
            if (provider === 'gemini') {
                const testModels = [
                    'gemini-3.5-flash-lite',
                    'gemini-2.5-flash-lite',
                    'gemini-2.0-flash-lite',
                    'gemini-1.5-flash-lite',
                    'gemini-flash-lite',
                    'gemini-2.0-flash',
                    'gemini-1.5-flash'
                ];

                const tryPing = (modelIdx) => {
                    if (modelIdx >= testModels.length) {
                        if (testBtn) testBtn.disabled = false;
                        setStatusUI('❌ Invalid', '#ff4d4d', '#ff4d4d');
                        addLog("❌ Gemini API Key Ping Failed: Key invalid or access denied.");
                        resolve(false);
                        return;
                    }
                    const modelName = testModels[modelIdx];
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${testKey}`;

                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: url,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
                        onload: function (res) {
                            try {
                                const json = JSON.parse(res.responseText);
                                if (json.error) {
                                    if (json.error.code === 404 && modelIdx + 1 < testModels.length) {
                                        tryPing(modelIdx + 1);
                                        return;
                                    }
                                    if (testBtn) testBtn.disabled = false;
                                    setStatusUI('❌ Invalid', '#ff4d4d', '#ff4d4d');
                                    addLog(`❌ Gemini API Key Ping Failed (${json.error.code}): ${json.error.message}`);
                                    resolve(false);
                                    return;
                                }
                                if (json.candidates && json.candidates.length > 0) {
                                    if (testBtn) testBtn.disabled = false;
                                    config.apiKey = testKey;
                                    GM_setValue('qlik_apiKey_v9', testKey);
                                    setStatusUI('✅ Verified', '#4dff88', '#009845');
                                    addLog(`✅ Gemini API Key verified & saved! (${modelName})`);
                                    resolve(true);
                                    return;
                                }
                            } catch (e) { }
                            tryPing(modelIdx + 1);
                        },
                        onerror: function () {
                            tryPing(modelIdx + 1);
                        }
                    });
                };
                tryPing(0);
            } else if (provider === 'openai') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://api.openai.com/v1/models',
                    headers: { 'Authorization': `Bearer ${testKey}` },
                    onload: function (res) {
                        if (testBtn) testBtn.disabled = false;
                        if (res.status === 200) {
                            config.apiKey = testKey;
                            GM_setValue('qlik_apiKey_v9', testKey);
                            setStatusUI('✅ Verified', '#4dff88', '#009845');
                            addLog("✅ OpenAI API Key ping successful! Key accepted & saved.");
                            resolve(true);
                        } else {
                            setStatusUI('❌ Invalid', '#ff4d4d', '#ff4d4d');
                            addLog(`❌ OpenAI API Key Ping Failed (HTTP ${res.status})`);
                            resolve(false);
                        }
                    },
                    onerror: function () {
                        if (testBtn) testBtn.disabled = false;
                        setStatusUI('❌ Error', '#ff4d4d', '#ff4d4d');
                        addLog("❌ OpenAI API Key Ping Failed: Network error.");
                        resolve(false);
                    }
                });
            } else {
                if (testBtn) testBtn.disabled = false;
                resolve(false);
            }
        });
    }

    async function queryGeminiAIForQuiz(context) {
        if (!config.apiKey) {
            addLog("⚠️ Gemini API Key missing or unverified! Please test & save your API key in the HUD.");
            return null;
        }

        let prompt = '';
        if (context.type === 'MCQ_SINGLE' || context.type === 'MCQ_MULTI') {
            prompt = `QUESTION STEM:
"${context.questionText}"

OPTIONS:
${context.options.map((opt, i) => `${i + 1}. ${opt.text}`).join('\n')}

INSTRUCTIONS FOR ULTRA-ACCURATE EXAM SOLVING:
1. Analyze the question stem with absolute technical precision based on official Qlik Sense Desktop and Qlik Cloud documentation, script syntax rules, and GUI behavior.
2. Pay extreme attention to True/False, script syntax (e.g. colon rules, LOAD statements, table labels), Data Manager, and visualization rules.
3. If the question asks for MULTIPLE correct answers (e.g., "Select 3", "Choose 2", "Which three...", "Select all that apply"), output ALL correct option index numbers in "selected_indices". Otherwise, output the single correct option index.

Output strictly valid JSON with no markdown formatting:
{
  "selected_indices": [1]
}`;
        } else if (context.type === 'MATCHING_DRAG_DROP') {
            prompt = `You are an expert Qlik Sense and Data Analytics exam solver.
Question: "${context.questionText}"
Question Type: Matching / Drag and Drop

Source Drag Items:
${context.sources.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}

Target Drop Zones:
${context.targets.map((t, i) => `${i + 1}. ${t.text}`).join('\n')}

Output strictly valid JSON with no markdown formatting:
{
  "matches": {
    "Exact Source Item Text": "Exact Target Drop Zone Text"
  }
}`;
        } else if (context.type === 'MATCHING_DROPDOWN') {
            prompt = `You are an expert Qlik Sense and Data Analytics exam solver.
Question: "${context.questionText}"
Question Type: Dropdown Matching

Items to Match:
${context.pairs.map((p, i) => `Item ${i + 1}: "${p.labelText}" | Dropdown Options: ${p.options.map(o => o.text).join(', ')}`).join('\n')}

Output strictly valid JSON with no markdown formatting:
{
  "matches": {
    "Item Label Text": "Exact Option Text"
  }
}`;
        }

        const models = [
            'gemini-3.5-flash-lite',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash-lite',
            'gemini-1.5-flash-lite',
            'gemini-flash-lite',
            'gemini-2.0-flash',
            'gemini-1.5-flash'
        ];

        const systemInstructionText = "You are a Qlik Certified Data Architect, Qlik Sense Business Analyst, and Master Exam Solver. You possess absolute technical expertise in Qlik Sense Desktop, Qlik Cloud, Data Load Scripting syntax, Data Manager, Data Model Viewer, and visualizations. Analyze each question with 100% technical precision according to official Qlik documentation and script syntax rules. Output strictly correct answer choices.";

        for (let modelName of models) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.apiKey}`;
            const result = await new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: url,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({
                        system_instruction: {
                            parts: [{ text: systemInstructionText }]
                        },
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: 0.0,
                            topP: 0.95,
                            responseMimeType: "application/json"
                        }
                    }),
                    onload: function (res) {
                        try {
                            const json = JSON.parse(res.responseText);
                            if (json.error) {
                                resolve(null);
                                return;
                            }
                            if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0]) {
                                const rawText = json.candidates[0].content.parts[0].text;
                                const parsed = parseCleanJSONResponse(rawText);
                                addLog(`Gemini AI (${modelName}) solved ${context.type}`);
                                resolve(parsed);
                                return;
                            }
                        } catch (e) {
                            addLog(`Gemini API (${modelName}) Parse Error: ${e.message}`);
                        }
                        resolve(null);
                    },
                    onerror: function () {
                        resolve(null);
                    }
                });
            });

            if (result) return result;
        }
        return null;
    }

    async function solveCurrentQuizStep() {
        if (quizState.isSolving || quizState.isLaunchingQuiz) return;
        quizState.isSolving = true;

        try {
            const context = parseQuizQuestionContext();
            if (!context) {
                addLog("Quiz mode: Scanning for question & options...");
                quizState.isSolving = false;
                return;
            }

            // Check if already processed this exact question signature
            if (context.signature === quizState.lastQuestionSignature) {
                quizState.sameSignatureCount = (quizState.sameSignatureCount || 0) + 1;
                const nextBtn = findQuizNextOrSubmitButton();
                if (nextBtn) {
                    addLog(`Same question signature active (${quizState.sameSignatureCount}). Re-clicking Next / Submit...`);
                    triggerClick(nextBtn);
                }
                if (quizState.sameSignatureCount >= 4) {
                    addLog("Resetting signature lock to force fresh question evaluation.");
                    quizState.lastQuestionSignature = '';
                    quizState.sameSignatureCount = 0;
                }
                quizState.isSolving = false;
                return;
            }

            const qStartTime = Date.now();
            quizState.lastQuestionSignature = context.signature;
            quizState.sameSignatureCount = 0;
            quizState.processedQuestionsCount++;

            addLog(`----------------------------------------`);
            addLog(`❓ Question #${quizState.processedQuestionsCount}: "${context.questionText.substring(0, 50)}..."`);
            addLog(`🔍 Searching for answer (${context.type})...`);
            updateStatusText(`Searching Q#${quizState.processedQuestionsCount} answer...`);

            let aiResult = null;
            if (config.apiKey && config.aiProvider === 'gemini') {
                aiResult = await queryGeminiAIForQuiz(context);
            }

            const searchTimeSec = ((Date.now() - qStartTime) / 1000).toFixed(1);

            // 1. EXECUTE MCQ (SINGLE & MULTI)
            if (context.type === 'MCQ_SINGLE' || context.type === 'MCQ_MULTI') {
                let selectedIndices = [0]; // default fallback: first option
                if (aiResult && Array.isArray(aiResult.selected_indices) && aiResult.selected_indices.length > 0) {
                    selectedIndices = aiResult.selected_indices.map(i => i - 1).filter(i => i >= 0 && i < context.options.length);
                }

                const selectedOpts = selectedIndices.map(i => context.options[i]).filter(Boolean);
                const selectedTextList = selectedOpts.map(o => `Option ${context.options.indexOf(o) + 1}: "${o.text.substring(0, 30)}"`).join(', ');

                addLog(`💡 Answer found in ${searchTimeSec}s! ${selectedTextList}`);
                addLog(`🎯 Selecting option(s) on page...`);

                for (let i = 0; i < selectedOpts.length; i++) {
                    const optObj = selectedOpts[i];
                    if (optObj && optObj.el) {
                        if (i > 0) await new Promise(r => setTimeout(r, 120));
                        triggerClick(optObj.el);
                    }
                }
            }
            // 2. EXECUTE MATCHING / DRAG & DROP
            else if (context.type === 'MATCHING_DRAG_DROP') {
                if (!context.sources || context.sources.length === 0 || !context.targets || context.targets.length === 0) {
                    haltAutopilotWithError("Unable to detect matching cards on screen. Autopilot halted for manual rearrangement.");
                    quizState.isSolving = false;
                    return;
                }

                if (!aiResult || !aiResult.matches || Object.keys(aiResult.matches).length === 0) {
                    haltAutopilotWithError("AI failed to solve card matching pairs. Autopilot halted for manual rearrangement.");
                    quizState.isSolving = false;
                    return;
                }

                const matchPairs = Object.entries(aiResult.matches).map(([s, t]) => `"${s.substring(0, 18)}..." ➔ "${t.substring(0, 18)}..."`).join(', ');
                addLog(`💡 Answer found in ${searchTimeSec}s! Matching pairs: ${matchPairs}`);
                addLog(`🎯 Performing Drag & Drop card rearrangement...`);

                let successCount = 0;
                for (let srcText in aiResult.matches) {
                    const targetText = aiResult.matches[srcText];
                    const sourceObj = context.sources.find(s => s.text.toLowerCase().includes(srcText.toLowerCase()) || srcText.toLowerCase().includes(s.text.toLowerCase()));
                    const targetObj = context.targets.find(t => t.text.toLowerCase().includes(targetText.toLowerCase()) || targetText.toLowerCase().includes(t.text.toLowerCase()));

                    if (sourceObj && targetObj) {
                        simulateDragAndDrop(sourceObj.el, targetObj.el);
                        successCount++;
                    }
                }

                if (successCount === 0) {
                    haltAutopilotWithError("Could not match card elements on DOM. Autopilot halted for manual rearrangement.");
                    quizState.isSolving = false;
                    return;
                }
            }
            // 3. EXECUTE DROPDOWN MATCHING
            else if (context.type === 'MATCHING_DROPDOWN') {
                if (aiResult && aiResult.matches) {
                    addLog(`💡 Answer found in ${searchTimeSec}s! Setting dropdown values...`);
                    for (let pair of context.pairs) {
                        const matchedText = aiResult.matches[pair.labelText];
                        if (matchedText) {
                            const optMatch = pair.options.find(o => o.text.toLowerCase().includes(matchedText.toLowerCase()));
                            if (optMatch) {
                                pair.selectEl.value = optMatch.value;
                                pair.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                                addLog(`Matched "${pair.labelText}" ➔ "${optMatch.text}"`);
                            }
                        }
                    }
                }
            }

            // Mandatory 3-second delay before submitting/clicking next
            addLog("⏳ Option(s) selected. Waiting 3 seconds before submitting answer...");
            updateStatusText(`Q#${quizState.processedQuestionsCount}: Waiting 3s to submit...`);

            let countdown = 3;
            const timerInterval = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    updateStatusText(`Q#${quizState.processedQuestionsCount}: Submitting in ${countdown}s...`);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(timerInterval);
                const nextBtn = findQuizNextOrSubmitButton();
                if (nextBtn) {
                    const totalTime = ((Date.now() - qStartTime) / 1000).toFixed(1);
                    addLog(`🚀 Submitting Q#${quizState.processedQuestionsCount} (Total Q time: ${totalTime}s)...`);
                    triggerClick(nextBtn);

                    // Secondary check for post-submit Continue / Next button
                    setTimeout(() => {
                        const nextBtn2 = findQuizNextOrSubmitButton();
                        if (nextBtn2 && nextBtn2 !== nextBtn) {
                            addLog("Found post-submit Next button. Clicking to advance...");
                            triggerClick(nextBtn2);
                        }
                    }, 600);
                } else {
                    addLog("Options applied. Waiting for next button or quiz completion screen...");
                }
                quizState.isSolving = false;
            }, 3000);

        } catch (e) {
            console.error("Quiz solve error:", e);
            quizState.isSolving = false;
        }
    }

    // --------------------------------------------------
    // PAGE MODE IDENTIFICATION
    // --------------------------------------------------
    function tabHasVideo(doc = document) {
        const isUploadResource = window.location.pathname.includes('/uploads/resource_courses/');
        const isPlayerUrl = window.location.pathname.includes('/player/') || window.location.pathname.includes('/video/');
        const hasVideo = doc.querySelector('video') !== null;
        const hasIframeVideo = doc.querySelector('iframe[src*="vimeo"], iframe[src*="youtube"], iframe[src*="wistia"]') !== null;

        if (isUploadResource || isPlayerUrl || hasVideo || hasIframeVideo) return true;

        const allIframes = getAllIframes(doc);
        for (let iframe of allIframes) {
            try {
                const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (innerDoc && innerDoc.querySelector('video')) return true;
            } catch (e) { }
        }
        return false;
    }

    function getPageMode() {
        if (tabHasVideo()) return 'PLAYER';
        return 'COORDINATOR';
    }

    // --------------------------------------------------
    // PLAYER MODE (RUNS IN VIDEO TAB)
    // --------------------------------------------------
    let videoCheckTimer = null;
    let videoFinishTriggered = false;

    function runPlayerMode() {
        videoCheckTimer = setInterval(() => {
            if (GM_getValue('qlik_enabled_v9', false)) {
                const actionBtn = findContinueOrGetStartedButton();
                if (actionBtn && !actionBtn.dataset.autopilotPressed) {
                    actionBtn.dataset.autopilotPressed = 'true';
                    addLog("New tab: Found 'Continue Learning' / 'Get Started' button. Pressing it...");
                    actionBtn.click();
                }

                if (tabHasVideo()) {
                    const currentState = GM_getValue('qlik_state_v9', STATE.IDLE);
                    if (currentState !== STATE.PLAYING_VIDEO) {
                        addLog("Video detected in new tab. Changing state to PLAYING_VIDEO.");
                        GM_setValue('qlik_state_v9', STATE.PLAYING_VIDEO);
                        GM_setValue('qlik_videoStartTime_v9', Date.now());
                        GM_setValue('qlik_lastStateTime_v9', Date.now());
                    }
                }
            }

            const video = document.querySelector('video');
            if (video) {
                if (isNaN(video.duration) || video.duration < 5) return;
                if (video.playbackRate !== config.playbackSpeed) {
                    video.playbackRate = config.playbackSpeed;
                }
                if (video.paused && !video.ended) {
                    video.muted = true;
                    video.play().catch(e => { });
                }
                if (video.ended && !videoFinishTriggered) {
                    videoFinishTriggered = true;
                    onVideoFinished();
                }
            } else {
                const allIframes = getAllIframes(document);
                for (let iframe of allIframes) {
                    try {
                        const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
                        const innerVideo = innerDoc.querySelector('video');
                        if (innerVideo) {
                            if (isNaN(innerVideo.duration) || innerVideo.duration < 5) break;
                            if (innerVideo.playbackRate !== config.playbackSpeed) {
                                innerVideo.playbackRate = config.playbackSpeed;
                            }
                            if (innerVideo.paused && !innerVideo.ended) {
                                innerVideo.muted = true;
                                innerVideo.play().catch(e => { });
                            }
                            if (innerVideo.ended && !videoFinishTriggered) {
                                videoFinishTriggered = true;
                                onVideoFinished();
                            }
                            break;
                        }
                    } catch (e) {
                        const src = iframe.src || '';
                        if (src.includes('vimeo.com')) {
                            iframe.contentWindow.postMessage(JSON.stringify({ method: 'setPlaybackRate', value: config.playbackSpeed }), '*');
                            iframe.contentWindow.postMessage(JSON.stringify({ method: 'play' }), '*');
                        }
                    }
                }
            }
        }, 2000);

        window.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.event === 'finish' || data.event === 'ended') {
                    if (data.data && data.data.duration && data.data.duration < 5) return;
                    if (!videoFinishTriggered) {
                        videoFinishTriggered = true;
                        onVideoFinished();
                    }
                }
            } catch (e) { }
        });
    }

    function onVideoFinished() {
        clearInterval(videoCheckTimer);
        localStorage.setItem('qlik_autopilot_finished_time_v9', Date.now().toString());
        setTimeout(() => {
            window.close();
        }, config.videoFinishDelay);
    }

    // --------------------------------------------------
    // COORDINATOR MODE (MAIN LOOP & ROUTER)
    // --------------------------------------------------
    function findContinueOrGetStartedButton(doc = document) {
        const directPlay = doc.querySelector('.activityheading__continuelearningcontent');
        if (directPlay && isElementVisible(directPlay) && !isInsideSidebarOrDrawer(directPlay)) return directPlay;

        const elements = querySelectorAllCrossFrame('button, a, div[role="button"], span, input[type="button"], input[type="submit"]');
        for (let btn of elements) {
            if (btn.textContent || btn.value) {
                const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
                if (txt.includes('continue learning') || txt.includes('get started') || txt.includes('launch')) {
                    if (isElementVisible(btn) && !isInsideSidebarOrDrawer(btn)) return btn;
                }
            }
        }
        return null;
    }

    function getPlayCourseButton() {
        const directPlay = document.querySelector('.activityheading__continuelearningcontent');
        if (directPlay && isElementVisible(directPlay) && !isInsideSidebarOrDrawer(directPlay)) return directPlay;

        const elements = querySelectorAllCrossFrame('button, a, div[role="button"], span');
        for (let btn of elements) {
            if (btn.textContent) {
                const txt = btn.textContent.trim().toLowerCase();
                if (txt.includes('continue learning') || txt.includes('get started') || txt.includes('resume') || txt.includes('start') || txt.includes('launch') || txt.includes('play')) {
                    if (isElementVisible(btn) && !isInsideSidebarOrDrawer(btn)) return btn;
                }
            }
        }
        return null;
    }

    function isInsideCourse() {
        return window.location.pathname.includes('/activity/');
    }

    function getReturnToActivityButton() {
        const elements = querySelectorAllCrossFrame('button, a, div[role="button"], span');
        for (let btn of elements) {
            if (btn.textContent) {
                const txt = btn.textContent.trim().toLowerCase();
                if (txt.includes('return to activity') || txt.includes('back to course')) {
                    if (isElementVisible(btn)) return btn;
                }
            }
        }
        return null;
    }

    function getNextActivityLink() {
        const directNext = document.querySelector('.coursepage__navlink--next, .coursepage__navlink.coursepage__navlink--next');
        if (directNext && isElementVisible(directNext)) return directNext;

        const elements = querySelectorAllCrossFrame('div, span, p, h1, h2, h3, h4, h5, h6, label, a');
        let foundLabel = null;
        for (let el of elements) {
            const txt = el.textContent ? el.textContent.trim().toLowerCase() : '';
            if (txt === 'next activity' || txt === 'next path' || txt.includes('next activity') || txt.includes('next path')) {
                if (!txt.includes('previous') && isElementVisible(el)) {
                    foundLabel = el;
                    break;
                }
            }
        }

        if (foundLabel) {
            const doc = foundLabel.ownerDocument || document;
            const allLinks = Array.from(doc.querySelectorAll('a'));
            for (let link of allLinks) {
                if (foundLabel.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    if (link.href && (link.href.includes('/activity/') || link.href.includes('/collection/') || link.href.includes('/path/'))) {
                        if (isElementVisible(link)) return link;
                    }
                }
            }
        }

        const circularButton = document.querySelector('.next-activity-btn, [class*="next-activity"], [class*="next-path"] a');
        if (circularButton && isElementVisible(circularButton)) return circularButton;

        return null;
    }

    function findAssessmentCloseButton() {
        const candidates = querySelectorAllCrossFrame('button, a, div[role="button"], span[role="button"], input[type="button"], input[type="submit"]');
        for (let el of candidates) {
            if (!isElementVisible(el)) continue;
            const txt = (el.textContent || el.value || '').trim().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const cls = (el.className || '').toLowerCase();
            if (txt === 'close' || txt.includes('close') || id.includes('close') || cls.includes('close') || txt === '×' || txt === 'x') {
                return el;
            }
        }
        return null;
    }

    function findQuizReviewButton() {
        const candidates = querySelectorAllCrossFrame('#launch_assessment, button, a, div[role="button"], span[role="button"], input[type="button"], input[type="submit"], [id*="review"], [class*="review"]');
        for (let el of candidates) {
            if (!isElementVisible(el) || isInsideSidebarOrDrawer(el)) continue;
            const txt = (el.textContent || el.value || '').trim().toLowerCase();
            const id = (el.id || '').toLowerCase();
            if (txt.includes('review') || txt.includes('view responses') || txt.includes('view score') || id.includes('review_assessment') || id.includes('review_quiz')) {
                return el;
            }
        }
        return null;
    }

    function findMarkAsCompleteButton() {
        const candidates = querySelectorAllCrossFrame('button, a, div[role="button"], span[role="button"], input[type="button"], input[type="submit"], [id*="complete"], [class*="complete"]');
        for (let el of candidates) {
            if (!isElementVisible(el) || isInsideSidebarOrDrawer(el)) continue;
            const txt = (el.textContent || el.value || '').trim().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const cls = (el.className || '').toLowerCase();

            if (txt.includes('mark as complete') || txt.includes('mark complete') || txt.includes('complete activity') || txt.includes('complete lesson') || id.includes('mark_complete') || cls.includes('mark-complete')) {
                return el;
            }
        }
        return null;
    }

    function coordinatorLoop() {
        if (!config.enabled) return;

        const activeTabId = GM_getValue('qlik_active_tab_v9');
        if (activeTabId && activeTabId !== tabId) {
            updateStatusText("Inactive Tab (Child)");
            return;
        }

        config.state = GM_getValue('qlik_state_v9', STATE.IDLE);
        config.videoStartTime = GM_getValue('qlik_videoStartTime_v9', 0);
        config.enabled = GM_getValue('qlik_enabled_v9', false);

        if (window.location.pathname !== currentUrlPath) {
            addLog(`URL path change detected: ${currentUrlPath} ➔ ${window.location.pathname}`);
            currentUrlPath = window.location.pathname;
            transitionState(STATE.IDLE);
        }

        // ASSESSMENT REPORT PAGE ROUTER
        const isReportPage = window.location.pathname.includes('/assessment_responses/report/') ||
            window.location.pathname.includes('/report/') ||
            window.location.href.includes('/assessment_responses/report/') ||
            document.body.textContent.includes('Assessment Passed') ||
            document.body.textContent.includes('Assessment Failed') ||
            document.body.textContent.includes('Total Points:');

        if (isReportPage) {
            updateStatusText("Report Page: Closing...");
            const closeBtn = findAssessmentCloseButton();
            if (closeBtn && !closeBtn.dataset.autopilotClicked) {
                closeBtn.dataset.autopilotClicked = 'true';
                addLog("Assessment Report Page detected. Clicking 'Close' button...");
                triggerClick(closeBtn);
                setTimeout(() => {
                    addLog("Report closed. Navigating to next activity...");
                    transitionState(STATE.NAVIGATING_NEXT);
                }, 1500);
                return;
            } else if (!closeBtn && config.state !== STATE.NAVIGATING_NEXT) {
                addLog("Report Page detected ('Close' button handled). Navigating to next activity...");
                transitionState(STATE.NAVIGATING_NEXT);
            }
        }

        // QUIZ DETECTOR ROUTER (Strictly active ONLY on URLs containing /activity/ or /assessment_responses/)
        const currentUrl = window.location.href;
        const isActivityUrl = currentUrl.includes('/activity/') || currentUrl.includes('/assessment_responses/');

        if (config.autoSolveQuiz && isActivityUrl) {
            const reviewBtn = findQuizReviewButton();

            if (reviewBtn && config.state !== STATE.TAKING_QUIZ) {
                if (!reviewBtn.dataset.autopilotSkipped) {
                    reviewBtn.dataset.autopilotSkipped = 'true';
                    addLog("Completed quiz detected (Review button present). Skipping quiz and advancing to Next Activity...");
                    transitionState(STATE.NAVIGATING_NEXT);
                    return;
                }
            } else if (!reviewBtn) {
                const launchBtn = findLaunchOrStartQuizButton();
                if (launchBtn && config.state !== STATE.TAKING_QUIZ) {
                    if (!launchBtn.dataset.autopilotClicked) {
                        launchBtn.dataset.autopilotClicked = 'true';
                        addLog("Found Quiz Launch button (#launch_assessment). Clicking to launch quiz...");
                        quizState.isLaunchingQuiz = true;
                        triggerClick(launchBtn);
                        transitionState(STATE.TAKING_QUIZ);
                        setTimeout(() => { quizState.isLaunchingQuiz = false; }, 3500);
                        return;
                    }
                } else {
                    const quizQ = findQuizQuestionElement();
                    if (quizQ && config.state !== STATE.TAKING_QUIZ) {
                        transitionState(STATE.TAKING_QUIZ);
                    }
                }
            }
        }

        switch (config.state) {
            case STATE.IDLE:
                const inside = isInsideCourse();

                if (!inside && !tabHasVideo()) {
                    const overviewBtn = getPlayCourseButton() || findContinueOrGetStartedButton();
                    if (overviewBtn) {
                        if (!overviewBtn.dataset.autopilotClicked) {
                            overviewBtn.dataset.autopilotClicked = 'true';
                            addLog("Overview page: Clicking 'Get Started' in same tab...");
                            if (overviewBtn.getAttribute('target') === '_blank') {
                                overviewBtn.setAttribute('target', '_self');
                            }
                            if (overviewBtn.href && overviewBtn.href.startsWith('http')) {
                                window.location.href = overviewBtn.href;
                            } else {
                                overviewBtn.click();
                            }
                        }
                        updateStatusText("Navigating to activity...");
                        break;
                    } else {
                        updateStatusText("Overview Page (Standing by)");
                        break;
                    }
                }

                const playBtn = getPlayCourseButton() || findContinueOrGetStartedButton();
                if (playBtn) {
                    addLog("Activity page: Clicking button to launch content...");
                    const mins = getCurrentPageDuration();
                    const title = getCurrentActivityTitle();
                    const waitTimeSeconds = Math.round((mins * 60) / config.playbackSpeed) + 15;
                    GM_setValue('qlik_targetWaitMs_v9', waitTimeSeconds * 1000);

                    if (playBtn.getAttribute('target') === '_blank') {
                        playBtn.setAttribute('target', '_self');
                    }
                    playBtn.click();

                    transitionState(STATE.PLAYING_VIDEO);
                    config.videoStartTime = Date.now();
                    GM_setValue('qlik_videoStartTime_v9', config.videoStartTime);
                    addLog(`Lesson: "${title}" (${mins} mins). Watch time: ${waitTimeSeconds}s.`);
                } else if (tabHasVideo()) {
                    addLog("Video player detected. Transitioning to PLAYING_VIDEO...");
                    const mins = getCurrentPageDuration();
                    const title = getCurrentActivityTitle();
                    const waitTimeSeconds = Math.round((mins * 60) / config.playbackSpeed) + 15;

                    GM_setValue('qlik_targetWaitMs_v9', waitTimeSeconds * 1000);
                    transitionState(STATE.PLAYING_VIDEO);
                    config.videoStartTime = Date.now();
                    GM_setValue('qlik_videoStartTime_v9', config.videoStartTime);
                } else {
                    const markCompleteBtn = findMarkAsCompleteButton();
                    if (markCompleteBtn && !markCompleteBtn.dataset.autopilotClicked) {
                        markCompleteBtn.dataset.autopilotClicked = 'true';
                        addLog("Reading activity detected (no video). Clicking 'Mark as complete'...");
                        triggerClick(markCompleteBtn);
                        setTimeout(() => {
                            addLog("Marked as complete. Navigating to next activity...");
                            transitionState(STATE.NAVIGATING_NEXT);
                        }, 1500);
                        break;
                    }

                    const idleElapsed = Date.now() - config.lastStateTime;
                    if (idleElapsed < 6000) {
                        updateStatusText(`Scanning page... (${Math.ceil((6000 - idleElapsed) / 1000)}s)`);
                    } else {
                        addLog("No video/quiz found after 6s. Navigating to next activity...");
                        transitionState(STATE.NAVIGATING_NEXT);
                    }
                }
                break;

            case STATE.TAKING_QUIZ:
                updateStatusText("Auto-Solving Quiz...");
                solveCurrentQuizStep();

                // Check if quiz has ended (no question element present + launch/completion/next link present)
                setTimeout(() => {
                    const activeQ = findQuizQuestionElement();
                    if (!activeQ) {
                        const nextLink = getNextActivityLink();
                        if (nextLink) {
                            addLog("Quiz completed! Transitioning to NAVIGATING_NEXT...");
                            transitionState(STATE.NAVIGATING_NEXT);
                        }
                    }
                }, 3000);
                break;

            case STATE.PLAYING_VIDEO:
                const elapsed = Date.now() - config.videoStartTime;
                const targetWaitMs = GM_getValue('qlik_targetWaitMs_v9', 150000);

                const remainingSecs = Math.max(0, Math.round((targetWaitMs - elapsed) / 1000));
                updateStatusText(`Watching Video (${remainingSecs}s remaining)`);

                const finishedTime = parseInt(localStorage.getItem('qlik_autopilot_finished_time_v9') || '0');
                const now = Date.now();
                const signalReceived = (now - finishedTime < 15000);
                const isClosed = activeChildWindow ? activeChildWindow.closed : false;

                if (elapsed >= targetWaitMs || isClosed || signalReceived) {
                    if (signalReceived) {
                        addLog("Video completed signal received.");
                        localStorage.removeItem('qlik_autopilot_finished_time_v9');
                    } else if (elapsed >= targetWaitMs) {
                        addLog("Target viewing time completed.");
                        if (activeChildWindow && !activeChildWindow.closed) {
                            activeChildWindow.close();
                        }
                    }
                    transitionState(STATE.VIDEO_FINISHED);
                }
                break;

            case STATE.VIDEO_FINISHED:
                const returnBtn = getReturnToActivityButton();
                if (returnBtn) {
                    addLog("Dismissing activity popup...");
                    returnBtn.click();
                    return;
                }

                const elapsedSinceFinish = Date.now() - config.lastStateTime;
                if (elapsedSinceFinish > 4000) {
                    addLog("Proceeding to navigation...");
                    transitionState(STATE.NAVIGATING_NEXT);
                }
                break;

            case STATE.NAVIGATING_NEXT:
                const nextLink = getNextActivityLink();
                if (nextLink) {
                    addLog(`Clicking next link: ${nextLink.textContent ? nextLink.textContent.trim() : nextLink.href}`);
                    nextLink.click();
                } else {
                    addLog("Navigation link not found. Autopilot paused.");
                    stopCoordinator();
                }
                break;
        }
    }

    function startCoordinator(forceClaim = false) {
        const currentActive = GM_getValue('qlik_active_tab_v9');
        if (forceClaim || !currentActive || currentActive === tabId) {
            GM_setValue('qlik_active_tab_v9', tabId);
        }

        if (mainLoopTimer) clearInterval(mainLoopTimer);
        coordinatorLoop();
        mainLoopTimer = setInterval(coordinatorLoop, config.checkInterval);
        addLog("Autopilot started");
    }

    function stopCoordinator() {
        const activeTabId = GM_getValue('qlik_active_tab_v9');
        if (activeTabId === tabId) {
            GM_setValue('qlik_active_tab_v9', '');
        }

        if (mainLoopTimer) {
            clearInterval(mainLoopTimer);
            mainLoopTimer = null;
        }
        updateStatusText("Autopilot Disabled");
        addLog("Autopilot stopped");
    }

    // --------------------------------------------------
    // MODERN GLASSMORPHIC UI OVERLAY
    // --------------------------------------------------
    function createUI() {
        const container = document.createElement('div');
        container.id = 'qlik-autopilot-container';

        const style = document.createElement('style');
        style.innerHTML = `
            #qlik-autopilot-container {
                position: fixed !important;
                bottom: 20px !important;
                right: 20px !important;
                width: 320px !important;
                background: rgba(25, 25, 25, 0.95) !important;
                backdrop-filter: blur(12px) saturate(180%) !important;
                border: 1px solid rgba(255, 255, 255, 0.15) !important;
                border-radius: 16px !important;
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.6) !important;
                color: #ffffff !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
                z-index: 999999 !important;
                overflow: hidden !important;
                transition: all 0.3s ease !important;
                user-select: text !important;
            }
            #qlik-autopilot-container * {
                color: #ffffff !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
                box-sizing: border-box !important;
            }
            #qlik-autopilot-header {
                background: linear-gradient(135deg, #009845 0%, #006837 100%) !important;
                padding: 12px 16px !important;
                font-weight: 700 !important;
                font-size: 13px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                cursor: pointer !important;
            }
            #qlik-autopilot-body {
                padding: 14px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 10px !important;
            }
            .qa-row {
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
            }
            .qa-label {
                font-size: 12px !important;
                font-weight: 600 !important;
                color: #d0d0d0 !important;
            }
            .qa-switch {
                position: relative !important;
                display: inline-block !important;
                width: 44px !important;
                height: 22px !important;
            }
            .qa-switch input { opacity: 0; width: 0; height: 0; }
            .qa-slider {
                position: absolute !important;
                cursor: pointer !important;
                top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
                background-color: #4a4a4a !important;
                transition: .3s !important;
                border-radius: 22px !important;
            }
            .qa-slider:before {
                position: absolute !important;
                content: "" !important;
                height: 14px !important;
                width: 14px !important;
                left: 4px !important;
                bottom: 4px !important;
                background-color: white !important;
                transition: .3s !important;
                border-radius: 50% !important;
            }
            input:checked + .qa-slider { background-color: #009845 !important; }
            input:checked + .qa-slider:before { transform: translateX(22px) !important; }

            .qa-box {
                background: rgba(255, 255, 255, 0.05) !important;
                border-radius: 8px !important;
                padding: 8px 12px !important;
                border: 1px solid rgba(255, 255, 255, 0.08) !important;
            }
            .qa-box-title {
                font-size: 9px !important;
                text-transform: uppercase !important;
                color: #a0a0a0 !important;
                margin-bottom: 2px !important;
                letter-spacing: 0.5px !important;
            }
            .qa-box-val {
                font-size: 12px !important;
                font-weight: 600 !important;
                color: #ffffff !important;
            }
            .qa-input-num, .qa-input-txt, .qa-select {
                width: 100% !important;
                background: rgba(0,0,0,0.6) !important;
                border: 1px solid rgba(255, 255, 255, 0.3) !important;
                border-radius: 4px !important;
                padding: 4px 6px !important;
                color: #ffffff !important;
                font-size: 11px !important;
            }
            #qa-logs-box {
                font-family: Consolas, Monaco, "Courier New", monospace !important;
                font-size: 11px !important;
                line-height: 1.4 !important;
                background: rgba(10, 15, 25, 0.9) !important;
                height: 150px !important;
                overflow-y: auto !important;
                padding: 8px !important;
                border-radius: 8px !important;
                border: 1px solid rgba(255, 255, 255, 0.15) !important;
                user-select: text !important;
                -webkit-user-select: text !important;
            }
            .qa-btn-sec {
                background: rgba(255,255,255,0.1) !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                color: white !important;
                padding: 4px 8px !important;
                border-radius: 4px !important;
                font-size: 10px !important;
                cursor: pointer !important;
            }
            .qa-btn-sec:hover { background: rgba(255,255,255,0.2) !important; }

            #qlik-autopilot-container.minimized { width: 160px !important; }
            #qlik-autopilot-container.minimized #qlik-autopilot-body { display: none !important; }
        `;
        document.head.appendChild(style);

        container.innerHTML = `
            <div id="qlik-autopilot-header">
                <span>🤖 Qlik Autopilot</span>
                <span style="font-size:9px; opacity:0.7;">v10.0</span>
            </div>
            <div id="qlik-autopilot-body">
                <div class="qa-row">
                    <span class="qa-label">Enable Autopilot</span>
                    <label class="qa-switch">
                        <input type="checkbox" id="qa-toggle-enabled" ${config.enabled ? 'checked' : ''}>
                        <span class="qa-slider"></span>
                    </label>
                </div>

                <div class="qa-row">
                    <span class="qa-label">Auto-Solve Quizzes</span>
                    <label class="qa-switch">
                        <input type="checkbox" id="qa-toggle-quiz" ${config.autoSolveQuiz ? 'checked' : ''}>
                        <span class="qa-slider"></span>
                    </label>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Current State</div>
                    <div class="qa-box-val" id="qa-status-text">${config.state}</div>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Speed & AI Settings</div>
                    <div class="qa-row" style="margin-top:4px;">
                        <span class="qa-label" style="font-size:11px;">Video Speed:</span>
                        <input type="number" class="qa-input-num" id="qa-cfg-speed" step="0.5" min="1" max="16" value="${config.playbackSpeed}" style="width:60px !important;">
                    </div>
                    <div style="margin-top:6px;">
                        <span class="qa-label" style="font-size:10px;">AI Provider:</span>
                        <select id="qa-cfg-provider" class="qa-select">
                            <option value="gemini" ${config.aiProvider === 'gemini' ? 'selected' : ''}>Gemini API</option>
                            <option value="openai" ${config.aiProvider === 'openai' ? 'selected' : ''}>OpenAI API</option>
                            <option value="heuristic" ${config.aiProvider === 'heuristic' ? 'selected' : ''}>Option 1 (Default)</option>
                        </select>
                    </div>
                    <div style="margin-top:6px;">
                        <div class="qa-row" style="margin-bottom:2px;">
                            <span class="qa-label" style="font-size:10px;">API Key:</span>
                            <span id="qa-key-status" style="font-size:10px; font-weight:600; color:${config.apiKey ? '#4dff88' : '#a0a0a0'};">${config.apiKey ? 'Saved' : 'Not Set'}</span>
                        </div>
                        <div style="display:flex; gap:4px;">
                            <input type="password" class="qa-input-txt" id="qa-cfg-apikey" value="${config.apiKey}" placeholder="Enter API Key & test..." style="flex:1;">
                            <button class="qa-btn-sec" id="qa-btn-test-key" style="background:#006837; font-size:10px; padding:3px 8px;">Test</button>
                        </div>
                    </div>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Manual Actions</div>
                    <div class="qa-row" style="margin-top:4px; gap:4px; flex-wrap:wrap;">
                        <button class="qa-btn-sec" id="qa-override-idle">Reset IDLE</button>
                        <button class="qa-btn-sec" id="qa-btn-launch-quiz" style="background:#006837;">Take Quiz</button>
                        <button class="qa-btn-sec" id="qa-override-next">Skip Next</button>
                        <button class="qa-btn-sec" id="qa-btn-clear-logs" style="background:#8b2525;">Clear Logs</button>
                    </div>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Persistent Logs</div>
                    <div id="qa-logs-box"></div>
                </div>
            </div>
        `;
        document.body.appendChild(container);

        // Bind DOM event listeners
        document.getElementById('qa-toggle-enabled').addEventListener('change', (e) => {
            config.enabled = e.target.checked;
            GM_setValue('qlik_enabled_v9', config.enabled);
            if (config.enabled) startCoordinator(true);
            else stopCoordinator();
        });

        document.getElementById('qa-toggle-quiz').addEventListener('change', (e) => {
            config.autoSolveQuiz = e.target.checked;
            GM_setValue('qlik_autoSolveQuiz_v9', config.autoSolveQuiz);
            addLog(`Auto-Solve Quizzes set to ${config.autoSolveQuiz}`);
        });

        document.getElementById('qa-cfg-speed').addEventListener('change', (e) => {
            let speed = parseFloat(e.target.value) || 2.0;
            speed = Math.max(1.0, Math.min(16.0, speed));
            config.playbackSpeed = speed;
            GM_setValue('qlik_playbackSpeed_v9', speed);
            addLog(`Target speed updated to ${speed}x`);
        });

        document.getElementById('qa-cfg-provider').addEventListener('change', (e) => {
            config.aiProvider = e.target.value;
            GM_setValue('qlik_aiProvider_v9', config.aiProvider);
            addLog(`AI Provider updated to ${config.aiProvider}`);
        });

        const handleApiKeyVerify = () => {
            const keyInput = document.getElementById('qa-cfg-apikey');
            const keyVal = keyInput ? keyInput.value.trim() : '';
            verifyAndSaveAPIKey(keyVal, config.aiProvider);
        };

        document.getElementById('qa-cfg-apikey').addEventListener('change', handleApiKeyVerify);
        document.getElementById('qa-btn-test-key').addEventListener('click', handleApiKeyVerify);

        document.getElementById('qlik-autopilot-header').addEventListener('click', () => {
            container.classList.toggle('minimized');
        });

        document.getElementById('qa-override-idle').addEventListener('click', () => {
            transitionState(STATE.IDLE);
            addLog("Manual Reset: State set to IDLE");
        });
        document.getElementById('qa-btn-launch-quiz').addEventListener('click', () => {
            const reviewBtn = findQuizReviewButton();
            const launchBtn = findLaunchOrStartQuizButton();

            if (reviewBtn && !launchBtn) {
                addLog("Manual Trigger: Quiz already completed ('Review' button present). Skipping quiz and advancing to Next Activity...");
                transitionState(STATE.NAVIGATING_NEXT);
                return;
            }

            if (launchBtn) {
                addLog("Manual Trigger: Found Quiz Launch button (#launch_assessment). Clicking to start quiz...");
                triggerClick(launchBtn);
                transitionState(STATE.TAKING_QUIZ);
            } else {
                addLog("Manual Trigger: Scanning for active quiz question/options...");
                const context = parseQuizQuestionContext();
                if (context) {
                    addLog(`Manual Trigger: Quiz question detected (${context.type}). Transitioning to TAKING_QUIZ...`);
                    transitionState(STATE.TAKING_QUIZ);
                } else {
                    addLog("Manual Trigger: No launch button or active quiz question found on current page.");
                }
            }
        });
        document.getElementById('qa-override-next').addEventListener('click', () => {
            transitionState(STATE.NAVIGATING_NEXT);
            addLog("Manual Skip: State set to NAVIGATING_NEXT");
        });
        document.getElementById('qa-btn-clear-logs').addEventListener('click', () => {
            logs = [];
            GM_setValue('qlik_logs_v9', []);
            updateLogUI();
        });

        updateLogUI();
        if (config.enabled) startCoordinator();
        else updateStatusText('Autopilot Disabled');
    }

    function updateStatusText(txt) {
        const el = document.getElementById('qa-status-text');
        if (el) el.textContent = txt;
    }

    function updateLogUI() {
        const logBox = document.getElementById('qa-logs-box');
        if (!logBox) return;

        logBox.innerHTML = '';
        logs.forEach(log => {
            const entry = document.createElement('div');
            entry.style.marginBottom = '4px';
            entry.style.wordBreak = 'break-word';
            entry.style.fontSize = '11px';
            entry.style.lineHeight = '1.35';

            if (log.includes('❓')) {
                entry.style.color = '#5ce1e6';
                entry.style.fontWeight = 'bold';
            } else if (log.includes('🔍')) {
                entry.style.color = '#ffd166';
            } else if (log.includes('💡')) {
                entry.style.color = '#00f5d4';
                entry.style.fontWeight = 'bold';
            } else if (log.includes('🎯') || log.includes('Pairing:')) {
                entry.style.color = '#ef476f';
            } else if (log.includes('🚀')) {
                entry.style.color = '#00b4d8';
                entry.style.fontWeight = 'bold';
            } else if (log.includes('⏳')) {
                entry.style.color = '#ffb703';
            } else if (log.includes('❌') || log.includes('⚠️')) {
                entry.style.color = '#ff4d4d';
                entry.style.fontWeight = 'bold';
            } else if (log.includes('✅')) {
                entry.style.color = '#4dff88';
                entry.style.fontWeight = 'bold';
            } else {
                entry.style.color = '#d0d0d0';
            }

            entry.textContent = log;
            logBox.appendChild(entry);
        });
        logBox.scrollTop = logBox.scrollHeight;
    }

    // --------------------------------------------------
    // INITIALIZATION ENTRYPOINT
    // --------------------------------------------------
    setTimeout(() => {
        const mode = getPageMode();
        if (mode === 'PLAYER') {
            runPlayerMode();
        } else {
            const lastUrlPath = GM_getValue('qlik_last_url_path_v9', '');
            if (lastUrlPath && lastUrlPath !== window.location.pathname) {
                config.state = STATE.IDLE;
                GM_setValue('qlik_state_v9', STATE.IDLE);
            }
            GM_setValue('qlik_last_url_path_v9', window.location.pathname);

            createUI();
            addLog('Qlik Sense Course & Quiz Autopilot initialized.');

            const currentState = GM_getValue('qlik_state_v9', STATE.IDLE);
            if (currentState === STATE.NAVIGATING_NEXT || currentState === STATE.VIDEO_FINISHED) {
                transitionState(STATE.IDLE);
            }

            window.addEventListener('unload', () => {
                if (GM_getValue('qlik_enabled_v9', false)) {
                    GM_setValue('qlik_state_v9', STATE.IDLE);
                }
            });
        }
    }, 1500);

})();
