// ==UserScript==
// @name         Qlik Sense Course Autopilot (Multi-Tab Edition)
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Automates page progression, opening videos in new tabs, setting 2x speed, and auto-closing them when finished.
// @author       Antigravity
// @match        https://learning.qlik.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @allFrames    true
// ==/UserScript==

(function () {
    'use strict';

    // --------------------------------------------------
    // ONLY RUN IN TOP-LEVEL WINDOWS
    // Prevents conflicts from tracking or background iframes
    // --------------------------------------------------
    if (window !== window.top) {
        return;
    }

    // Generate a unique ID for this browser tab session
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
        NAVIGATING_NEXT: 'NAVIGATING_NEXT'
    };

    // --------------------------------------------------
    // CONFIGURATION & DEFAULTS (V6 Storage Namespace)
    // --------------------------------------------------
    const DEFAULT_CONFIG = {
        enabled: false,
        state: STATE.IDLE,
        playbackSpeed: 2.0,         // Target video speed (2.0x)
        currentIndex: 0,            // Used in Sequential Mode
        useSequentialMode: true,    // True: opens index-by-index, False: looks for first incomplete selector
        checkInterval: 2500,        // ms
        videoFinishDelay: 2000,     // Delay in ms before closing tab after video ends
        noVideoTimeout: 15000,      // Delay in ms before auto-closing reading pages without videos
        videoStartTime: 0,
        lastStateTime: 0
    };

    // Helper to get safe numeric config values from GM storage (prevents old corrupt value loops)
    function getSafeNumber(key, defaultValue, minVal = 0) {
        let val = GM_getValue('qlik_' + key + '_v6');
        if (val === undefined || val === null || isNaN(Number(val))) {
            return defaultValue;
        }
        return Math.max(minVal, Number(val));
    }

    // Load active config or set defaults
    let config = {
        enabled: !!GM_getValue('qlik_enabled_v6', DEFAULT_CONFIG.enabled),
        state: GM_getValue('qlik_state_v6', DEFAULT_CONFIG.state) || STATE.IDLE,
        playbackSpeed: getSafeNumber('playbackSpeed', DEFAULT_CONFIG.playbackSpeed, 1.0),
        currentIndex: getSafeNumber('currentIndex', DEFAULT_CONFIG.currentIndex, 0),
        useSequentialMode: !!GM_getValue('qlik_useSequentialMode_v6', DEFAULT_CONFIG.useSequentialMode),
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

    function addLog(msg) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const logMsg = `[${time}] ${msg}`;

        let currentLogs = GM_getValue('qlik_logs_v6', []);
        if (!Array.isArray(currentLogs)) currentLogs = [];

        currentLogs.unshift(logMsg);
        if (currentLogs.length > 50) currentLogs.pop(); // Keep last 50 logs

        GM_setValue('qlik_logs_v6', currentLogs);
        logs = currentLogs;

        updateLogUI();
        console.log(`[Qlik Autopilot] ${msg}`);
    }

    function saveConfig() {
        for (let key in config) {
            GM_setValue('qlik_' + key + '_v6', config[key]);
        }
    }

    function transitionState(newState) {
        addLog(`Transitioning state: ${config.state} ➔ ${newState}`);
        config.state = newState;
        config.lastStateTime = Date.now();
        GM_setValue('qlik_state_v6', newState);
        GM_setValue('qlik_lastStateTime_v6', config.lastStateTime);
        updateStatusText(newState);
    }

    // --------------------------------------------------
    // CROSS-FRAME DOM UTILITIES
    // --------------------------------------------------
    function querySelectorAllCrossFrame(selector) {
        let elements = Array.from(document.querySelectorAll(selector));
        const iframes = document.querySelectorAll('iframe');
        for (let iframe of iframes) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDoc) {
                    const iframeEls = iframeDoc.querySelectorAll(selector);
                    elements = elements.concat(Array.from(iframeEls));
                }
            } catch (e) {
                // Ignore cross-origin frames
            }
        }
        return elements;
    }

    // Checks recursively if an element is visible on screen
    function isElementVisible(el) {
        if (!el) return false;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;

        const win = el.ownerDocument.defaultView || window;
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
            return false;
        }

        // Traverse up parent tree to check if any parent container is hidden
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

    // Helper to filter out elements inside side drawers, course maps, or TOC sidebars
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

    // Flatten all iframes dynamically to search deep nested player scripts
    function getAllIframes(doc) {
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
                } catch (e) {
                    // Cross-origin iframe
                }
            }
        } catch (e) {
            // Query selector exception
        }
        return list;
    }

    // --------------------------------------------------
    // DURATION SCRAPER (EXTRACTS FROM CURRENT PAGE METADATA)
    // --------------------------------------------------
    function getCurrentPageDuration() {
        const elements = document.querySelectorAll('div, span, p, li, td');
        for (let el of elements) {
            if (el.children.length < 3 && el.textContent) {
                const txt = el.textContent.replace(/\s+/g, ' ').trim();
                // Check for metadata line containing standard course keywords
                if (/Published|Beginner|Intermediate|Advanced|Learning/i.test(txt)) {
                    const match = txt.match(/\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
                    if (match) {
                        const mins = parseInt(match[1]);
                        if (mins > 0 && mins < 180) {
                            return mins;
                        }
                    }
                }
            }
        }
        return 5; // Safe default fallback
    }

    // Get current activity title from the page content
    function getCurrentActivityTitle() {
        const h1 = document.querySelector('h1');
        if (h1 && isElementVisible(h1)) {
            return h1.textContent.trim();
        }
        const heading = document.querySelector('[class*="heading"], [class*="title"]');
        if (heading && isElementVisible(heading)) {
            return heading.textContent.trim();
        }
        return document.title.replace('- Qlik Learning', '').trim();
    }

    // --------------------------------------------------
    // PAGE MODE IDENTIFICATION
    // --------------------------------------------------
    function tabHasVideo(doc = document) {
        const isUploadResource = window.location.pathname.includes('/uploads/resource_courses/');
        const isPlayerUrl = window.location.pathname.includes('/player/') || window.location.pathname.includes('/video/');
        const hasVideo = doc.querySelector('video') !== null;
        const hasIframeVideo = doc.querySelector('iframe[src*="vimeo"], iframe[src*="youtube"], iframe[src*="wistia"]') !== null;

        if (isUploadResource || isPlayerUrl || hasVideo || hasIframeVideo) {
            return true;
        }

        const allIframes = getAllIframes(doc);
        for (let iframe of allIframes) {
            try {
                const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (innerDoc && innerDoc.querySelector('video')) {
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }

    function getPageMode() {
        if (tabHasVideo()) {
            return 'PLAYER';
        }
        return 'COORDINATOR';
    }

    // --------------------------------------------------
    // PLAYER MODE (RUNS IN VIDEO TAB)
    // --------------------------------------------------
    let videoCheckTimer = null;
    let videoFinishTriggered = false;

    function runPlayerMode() {
        // Playback speed setter runs in child tab to play video at 2x speed
        videoCheckTimer = setInterval(() => {
            if (GM_getValue('qlik_enabled_v6', false)) {
                const actionBtn = findContinueOrGetStartedButton();
                if (actionBtn && !actionBtn.dataset.autopilotPressed) {
                    actionBtn.dataset.autopilotPressed = 'true';
                    addLog("New tab: Found 'Continue Learning' / 'Get Started' button. Pressing it...");
                    actionBtn.click();
                }

                if (tabHasVideo()) {
                    const currentState = GM_getValue('qlik_state_v6', STATE.IDLE);
                    if (currentState !== STATE.PLAYING_VIDEO) {
                        addLog("Video detected in new tab. Changing state to PLAYING_VIDEO.");
                        GM_setValue('qlik_state_v6', STATE.PLAYING_VIDEO);
                        GM_setValue('qlik_videoStartTime_v6', Date.now());
                        GM_setValue('qlik_lastStateTime_v6', Date.now());
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

        // Listen for postMessage finish triggers (Vimeo iframe fallback)
        window.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.event === 'finish' || data.event === 'ended') {
                    if (data.data && data.data.duration && data.data.duration < 5) {
                        return; // Ignore tiny postmessage videos
                    }
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

        // Notify Coordinator Tab via localStorage (V6 Namespace)
        localStorage.setItem('qlik_autopilot_finished_time_v6', Date.now().toString());

        setTimeout(() => {
            window.close();
        }, config.videoFinishDelay);
    }

    // --------------------------------------------------
    // COORDINATOR MODE (RUNS ON MAIN LIST PAGE)
    // --------------------------------------------------
    function findContinueOrGetStartedButton(doc = document) {
        const directPlay = doc.querySelector('.activityheading__continuelearningcontent');
        if (directPlay && isElementVisible(directPlay) && !isInsideSidebarOrDrawer(directPlay)) return directPlay;

        const elements = querySelectorAllCrossFrame('button, a, div[role="button"], span, input[type="button"], input[type="submit"]');
        for (let btn of elements) {
            if (btn.textContent || btn.value) {
                const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
                if (txt.includes('continue learning') || txt.includes('get started')) {
                    if (isElementVisible(btn) && !isInsideSidebarOrDrawer(btn)) return btn;
                }
            }
        }
        return null;
    }

    function getPlayCourseButton() {
        // Look for Qlik continue learning button in the main content area only
        const directPlay = document.querySelector('.activityheading__continuelearningcontent');
        if (directPlay && isElementVisible(directPlay) && !isInsideSidebarOrDrawer(directPlay)) return directPlay;

        const elements = querySelectorAllCrossFrame('button, a, div[role="button"], span');
        for (let btn of elements) {
            if (btn.textContent) {
                const txt = btn.textContent.trim().toLowerCase();
                if (txt.includes('continue learning') ||
                    txt.includes('get started') ||
                    txt.includes('resume') ||
                    txt.includes('start') ||
                    txt.includes('play')) {
                    if (isElementVisible(btn) && !isInsideSidebarOrDrawer(btn)) return btn;
                }
            }
        }
        return null;
    }

    function isInsideCourse() {
        // Real lesson/quiz activity pages contain '/activity/' in the URL pathname
        return window.location.pathname.includes('/activity/');
    }

    function getReturnToActivityButton() {
        const elements = querySelectorAllCrossFrame('button, a, div[role="button"], span');
        for (let btn of elements) {
            if (btn.textContent) {
                const txt = btn.textContent.trim().toLowerCase();
                if (txt.includes('return to activity')) {
                    if (isElementVisible(btn)) return btn;
                }
            }
        }
        return null;
    }

    function getNextActivityLink() {
        // Direct class selector
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

    function coordinatorLoop() {
        if (!config.enabled) return;

        // Multi-Tab Lock Guard (V6 Storage Namespace)
        const activeTabId = GM_getValue('qlik_active_tab_v6');
        if (activeTabId && activeTabId !== tabId) {
            if (GM_getValue('qlik_enabled_v6', false)) {
                const actionBtn = findContinueOrGetStartedButton();
                if (actionBtn && !actionBtn.dataset.autopilotPressed) {
                    actionBtn.dataset.autopilotPressed = 'true';
                    addLog("Opened tab: Found 'Continue Learning' / 'Get Started' button. Pressing it...");
                    actionBtn.click();
                }

                if (tabHasVideo()) {
                    const currentState = GM_getValue('qlik_state_v6', STATE.IDLE);
                    if (currentState !== STATE.PLAYING_VIDEO) {
                        addLog("Video detected in opened tab. Changing state to PLAYING_VIDEO.");
                        GM_setValue('qlik_state_v6', STATE.PLAYING_VIDEO);
                        GM_setValue('qlik_videoStartTime_v6', Date.now());
                        GM_setValue('qlik_lastStateTime_v6', Date.now());
                    }
                    if (!videoCheckTimer) {
                        runPlayerMode();
                    }
                }
            }
            updateStatusText("Inactive Tab (Child)");
            return;
        }

        // Force config refresh from GM storage (V6 Namespace)
        config.state = GM_getValue('qlik_state_v6', STATE.IDLE);
        config.videoStartTime = GM_getValue('qlik_videoStartTime_v6', 0);
        config.enabled = GM_getValue('qlik_enabled_v6', false);

        // Detect dynamic AJAX URL path changes to auto-reset to IDLE
        if (window.location.pathname !== currentUrlPath) {
            addLog(`URL path change detected: ${currentUrlPath} ➔ ${window.location.pathname}`);
            currentUrlPath = window.location.pathname;
            transitionState(STATE.IDLE);
        }

        // State Machine Router
        switch (config.state) {
            case STATE.IDLE:
                const inside = isInsideCourse();

                // If on an overview / path page (URL does NOT contain '/activity/'), click Get Started in the SAME TAB (without opening new tab)
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
                    if (!playBtn.dataset.autopilotClicked) {
                        playBtn.dataset.autopilotClicked = 'true';
                        addLog("Found play/start button. Triggering click in same tab...");

                        const mins = getCurrentPageDuration();
                        const title = getCurrentActivityTitle();
                        const waitTimeSeconds = Math.round((mins * 60) / config.playbackSpeed) + 15;
                        const targetWaitMs = waitTimeSeconds * 1000;
                        GM_setValue('qlik_targetWaitMs_v6', targetWaitMs);

                        if (playBtn.getAttribute('target') === '_blank') {
                            playBtn.setAttribute('target', '_self');
                        }

                        if (playBtn.href && playBtn.href.startsWith('http')) {
                            window.location.href = playBtn.href;
                        } else {
                            playBtn.click();
                        }
                    }

                    if (tabHasVideo()) {
                        const title = getCurrentActivityTitle();
                        addLog(`Video player confirmed on page ("${title}"). Transitioning to PLAYING_VIDEO state.`);
                        transitionState(STATE.PLAYING_VIDEO);
                        config.videoStartTime = Date.now();
                        GM_setValue('qlik_videoStartTime_v6', config.videoStartTime);
                    } else {
                        updateStatusText("Navigating to lesson...");
                    }
                } else if (tabHasVideo()) {
                    addLog("Video player detected on screen. Transitioning to PLAYING_VIDEO state...");
                    const mins = getCurrentPageDuration();
                    const title = getCurrentActivityTitle();

                    const waitTimeSeconds = Math.round((mins * 60) / config.playbackSpeed) + 15;
                    const targetWaitMs = waitTimeSeconds * 1000;

                    GM_setValue('qlik_targetWaitMs_v6', targetWaitMs);
                    addLog(`Lesson: "${title}" (${mins} mins). Watch time at ${config.playbackSpeed}x speed: ${waitTimeSeconds} seconds.`);

                    transitionState(STATE.PLAYING_VIDEO);
                    config.videoStartTime = Date.now();
                    GM_setValue('qlik_videoStartTime_v6', config.videoStartTime);
                } else {
                    // Give DOM 6 seconds grace period to finish rendering dynamic buttons/videos
                    const idleElapsed = Date.now() - config.lastStateTime;
                    if (idleElapsed < 6000) {
                        updateStatusText(`Scanning page... (${Math.ceil((6000 - idleElapsed) / 1000)}s)`);
                    } else {
                        addLog("No play button or video found on screen after 6s. Proceeding to next activity...");
                        transitionState(STATE.NAVIGATING_NEXT);
                    }
                }
                break;

            case STATE.PLAYING_VIDEO:
                const elapsed = Date.now() - config.videoStartTime;
                const targetWaitMs = GM_getValue('qlik_targetWaitMs_v6', 150000);

                const remainingSecs = Math.max(0, Math.round((targetWaitMs - elapsed) / 1000));
                updateStatusText(`Watching Video (${remainingSecs}s remaining)`);

                // Check for localStorage completion signal from child tab
                const finishedTime = parseInt(localStorage.getItem('qlik_autopilot_finished_time_v6') || '0');
                const now = Date.now();
                const signalReceived = (now - finishedTime < 15000);

                const isClosed = activeChildWindow ? activeChildWindow.closed : false;

                if (elapsed >= targetWaitMs || isClosed || signalReceived) {
                    if (signalReceived) {
                        addLog("Video completed signal received from child tab.");
                        localStorage.removeItem('qlik_autopilot_finished_time_v6');
                    } else if (elapsed >= targetWaitMs) {
                        addLog("Target viewing time completed (fallback timer).");
                        if (activeChildWindow && !activeChildWindow.closed) {
                            addLog("Closing video tab.");
                            activeChildWindow.close();
                        }
                    } else {
                        addLog("Video tab closed early by user.");
                    }
                    transitionState(STATE.VIDEO_FINISHED);
                }
                break;

            case STATE.VIDEO_FINISHED:
                // Dismiss warning modal if present (ONLY after video is finished!)
                const returnBtn = getReturnToActivityButton();
                if (returnBtn) {
                    addLog("Dismissing activity popup...");
                    returnBtn.click();
                    return; // Wait for next tick to navigate
                }

                const elapsedSinceFinish = Date.now() - config.lastStateTime;
                if (elapsedSinceFinish > 5000) {
                    addLog("No tracking popup found. Proceeding to navigation.");
                    transitionState(STATE.NAVIGATING_NEXT);
                }
                break;

            case STATE.NAVIGATING_NEXT:
                const nextLink = getNextActivityLink();
                if (nextLink) {
                    addLog(`Clicking next link: ${nextLink.textContent ? nextLink.textContent.trim() : nextLink.href}`);
                    // Trigger click, state remains NAVIGATING_NEXT to avoid play button race condition on slow load
                    nextLink.click();
                } else {
                    addLog("Navigation link not found. Autopilot paused.");
                    stopCoordinator();
                }
                break;
        }
    }

    // Reset loop
    function startCoordinator(forceClaim = false) {
        // Claim lock for this tab safely
        const currentActive = GM_getValue('qlik_active_tab_v6');
        if (forceClaim || !currentActive || currentActive === tabId) {
            GM_setValue('qlik_active_tab_v6', tabId);
        }

        if (mainLoopTimer) clearInterval(mainLoopTimer);
        coordinatorLoop();
        mainLoopTimer = setInterval(coordinatorLoop, config.checkInterval);
        addLog("Autopilot started");
    }

    // Reset loop
    function stopCoordinator() {
        // Release lock
        const activeTabId = GM_getValue('qlik_active_tab_v6');
        if (activeTabId === tabId) {
            GM_setValue('qlik_active_tab_v6', '');
        }

        if (mainLoopTimer) {
            clearInterval(mainLoopTimer);
            mainLoopTimer = null;
        }
        updateStatusText("Autopilot Disabled");
        addLog("Autopilot stopped");
    }

    // --------------------------------------------------
    // MODERN GLASSMORPHIC UI OVERLAY (COORDINATOR ONLY)
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
            /* Toggle Switch */
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
            .qa-input-num {
                width: 60px !important;
                background: rgba(0,0,0,0.6) !important;
                border: 1px solid rgba(255, 255, 255, 0.3) !important;
                border-radius: 4px !important;
                padding: 3px !important;
                color: #ffffff !important;
                font-size: 11px !important;
                text-align: center !important;
            }
            #qa-logs-box {
                font-family: monospace !important;
                font-size: 9px !important;
                color: #a2f2a2 !important;
                background: rgba(0,0,0,0.5) !important;
                height: 90px !important;
                overflow-y: auto !important;
                padding: 5px !important;
                border-radius: 6px !important;
                user-select: text !important;
                -webkit-user-select: text !important;
            }
            #qa-logs-box div {
                color: #a2f2a2 !important;
            }
            .qa-btn-sec {
                background: rgba(255,255,255,0.1) !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                color: white !important;
                padding: 3px 6px !important;
                border-radius: 4px !important;
                font-size: 10px !important;
                cursor: pointer !important;
            }
            .qa-btn-sec:hover { background: rgba(255,255,255,0.2) !important; }
            
            #qlik-autopilot-container.minimized {
                width: 160px !important;
            }
            #qlik-autopilot-container.minimized #qlik-autopilot-body {
                display: none !important;
            }
        `;
        document.head.appendChild(style);

        container.innerHTML = `
            <div id="qlik-autopilot-header">
                <span>🤖 Autopilot</span>
                <span style="font-size:9px; opacity:0.7;">v8.0</span>
            </div>
            <div id="qlik-autopilot-body">
                <div class="qa-row">
                    <span class="qa-label">Enable Autopilot</span>
                    <label class="qa-switch">
                        <input type="checkbox" id="qa-toggle-enabled" ${config.enabled ? 'checked' : ''}>
                        <span class="qa-slider"></span>
                    </label>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Current State</div>
                    <div class="qa-box-val" id="qa-status-text">${config.state}</div>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Speed Control</div>
                    <div class="qa-row" style="margin-top:4px;">
                        <span class="qa-label" style="font-size:11px;">Video Speed:</span>
                        <div>
                            <input type="number" class="qa-input-num" id="qa-cfg-speed" step="0.5" min="1" max="16" value="${config.playbackSpeed}">
                            <span style="font-size:11px; color:#a0a0a0;">x</span>
                        </div>
                    </div>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Debugging / Manual Override</div>
                    <div class="qa-row" style="margin-top:4px; gap:4px; flex-wrap:wrap;">
                        <button class="qa-btn-sec" id="qa-override-idle">Reset IDLE</button>
                        <button class="qa-btn-sec" id="qa-override-next">Skip Next</button>
                        <button class="qa-btn-sec" id="qa-btn-clear-logs" style="background:#8b2525;">Clear Logs</button>
                    </div>
                </div>

                <div class="qa-box">
                    <div class="qa-box-title">Persistent Logs (Copyable)</div>
                    <div id="qa-logs-box"></div>
                </div>
            </div>
        `;
        document.body.appendChild(container);

        // Bind DOM interactions
        const toggleBtn = document.getElementById('qa-toggle-enabled');
        toggleBtn.addEventListener('change', (e) => {
            config.enabled = e.target.checked;
            GM_setValue('qlik_enabled_v6', config.enabled);
            if (config.enabled) {
                startCoordinator(true);
            } else {
                stopCoordinator();
            }
        });

        // Speed settings listener
        const speedInput = document.getElementById('qa-cfg-speed');
        speedInput.addEventListener('change', (e) => {
            let speed = parseFloat(e.target.value) || 2.0;
            speed = Math.max(1.0, Math.min(16.0, speed));
            config.playbackSpeed = speed;
            GM_setValue('qlik_playbackSpeed_v6', speed);
            addLog(`Target speed updated to ${speed}x`);
        });

        // Header minimize toggle
        const header = document.getElementById('qlik-autopilot-header');
        header.addEventListener('click', () => {
            container.classList.toggle('minimized');
        });

        // Manual Override Buttons
        document.getElementById('qa-override-idle').addEventListener('click', () => {
            transitionState(STATE.IDLE);
            addLog("Manual Reset: State set to IDLE");
        });
        document.getElementById('qa-override-next').addEventListener('click', () => {
            transitionState(STATE.NAVIGATING_NEXT);
            addLog("Manual Skip: State set to NAVIGATING_NEXT");
        });
        document.getElementById('qa-btn-clear-logs').addEventListener('click', () => {
            logs = [];
            GM_setValue('qlik_logs_v6', []);
            updateLogUI();
        });

        updateLogUI();
        if (config.enabled) {
            startCoordinator();
        } else {
            updateStatusText('Autopilot Disabled');
        }
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
            entry.style.marginBottom = '2px';
            entry.style.wordBreak = 'break-all';
            entry.textContent = log;
            logBox.appendChild(entry);
        });
    }

    // --------------------------------------------------
    // INITIALIZATION ENTRYPOINT
    // --------------------------------------------------
    setTimeout(() => {
        const mode = getPageMode();
        if (mode === 'PLAYER') {
            runPlayerMode();
        } else {
            // Check if the URL pathname has changed from the last recorded coordinator page load
            const lastUrlPath = GM_getValue('qlik_last_url_path_v6', '');
            if (lastUrlPath && lastUrlPath !== window.location.pathname) {
                config.state = STATE.IDLE;
                GM_setValue('qlik_state_v6', STATE.IDLE);
            }
            GM_setValue('qlik_last_url_path_v6', window.location.pathname);

            createUI();
            addLog('Autopilot coordinator initialized in top window.');

            // Auto-reset state to IDLE on fresh page load to clear navigation state
            const currentState = GM_getValue('qlik_state_v6', STATE.IDLE);
            if (currentState === STATE.NAVIGATING_NEXT || currentState === STATE.VIDEO_FINISHED) {
                transitionState(STATE.IDLE);
            }

            // Listen to window unload event to reset state to IDLE when navigating the coordinator tab
            window.addEventListener('unload', () => {
                if (GM_getValue('qlik_enabled_v6', false)) {
                    GM_setValue('qlik_state_v6', STATE.IDLE);
                }
            });
        }
    }, 1500);

})();
