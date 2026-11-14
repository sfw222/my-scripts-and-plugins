// ==UserScript==
// @name         流畅阅读 · 油管字幕放到视频下方
// @namespace    https://github.com/sfw222
// @version      1.0.1
// @description  将流畅阅读双语字幕同步显示在 YouTube 视频下方，全屏时恢复视频内字幕，可选点击英文单词查词。
// @author       sfw222
// @homepageURL  https://github.com/sfw222/my-scripts-and-plugins
// @supportURL   https://github.com/sfw222/my-scripts-and-plugins/issues
// @updateURL    https://raw.githubusercontent.com/sfw222/my-scripts-and-plugins/main/fluent-read-youtube-subtitles.user.js
// @downloadURL  https://raw.githubusercontent.com/sfw222/my-scripts-and-plugins/main/fluent-read-youtube-subtitles.user.js
// @match        https://www.youtube.com/*
// @license      GPL-3.0-only
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    const panelId = 'fluent-read-video-subtitle-panel';
    const hostId = 'fr-below-video-subtitles';
    const hiddenAttribute = 'data-fr-below-video-hidden';
    const lineIds = [
        'fluent-read-video-subtitle-original',
        'fluent-read-video-subtitle-reading',
        'fluent-read-video-subtitle',
    ];
    let enabled = GM_getValue('belowVideoEnabled', true);
    let dictionaryEnabled = GM_getValue('openDictionary', false);
    let frame = 0;
    let sourcePanel = null;
    let sourceLayer = null;
    let sourcePlayer = null;
    let host = null;
    let content = null;
    let lastSignature = '';

    const pageStyle = document.createElement('style');
    pageStyle.textContent = `
        [${hiddenAttribute}] { opacity: 0 !important; pointer-events: none !important; }
        #${hostId} { display: block; width: 100%; min-width: 0; flex: 0 0 auto; }
        #${hostId}[hidden] { display: none !important; }
    `;
    document.head.append(pageStyle);

    // Keep the extension's nodes in place. Its renderer reparents them on updates.
    const sourceObserver = new MutationObserver(schedule);
    const playerObserver = new MutationObserver(schedule);
    const sizeObserver = new ResizeObserver(schedule);

    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }

    function createHost() {
        host = document.createElement('div');
        host.id = hostId;
        host.hidden = true;
        host.className = 'notranslate';
        host.setAttribute('translate', 'no');
        host.setAttribute('data-fluent-read-ui', 'video-subtitle');
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            :host { color-scheme: dark; }
            .subtitles {
                box-sizing: border-box; display: flex; flex-direction: column;
                justify-content: center; align-items: center; gap: 8px;
                min-height: 112px; max-height: 280px; padding: 16px 20px;
                overflow-y: auto; background: #111; color: #fff;
                border: 1px solid #444; border-top: 0;
                font: 20px/1.5 Arial, "Microsoft YaHei", sans-serif;
                text-align: center; overflow-wrap: anywhere;
                user-select: text; cursor: text;
            }
            .line { flex: 0 0 auto; width: 100%; white-space: pre-wrap; }
            .word { color: inherit; cursor: pointer; }
            .word:hover { text-decoration: underline; text-underline-offset: 3px; }
            @media (max-width: 600px) {
                .subtitles { min-height: 96px; padding: 12px; }
            }
        `;
        content = document.createElement('div');
        content.className = 'subtitles';
        content.setAttribute('role', 'region');
        content.setAttribute('aria-label', '流畅阅读双语字幕');
        shadow.append(style, content);
        content.addEventListener('click', lookupWord);
    }

    function restoreOverlay() {
        sourceLayer?.removeAttribute(hiddenAttribute);
        if (host) host.hidden = true;
    }

    function bindSource(panel, player) {
        const layer = panel?.parentElement ?? null;
        if (panel === sourcePanel && layer === sourceLayer && player === sourcePlayer) return;
        restoreOverlay();
        sourceObserver.disconnect();
        playerObserver.disconnect();
        sizeObserver.disconnect();
        sourcePanel = panel;
        sourceLayer = layer;
        sourcePlayer = player;
        lastSignature = '';
        if (panel) {
            sourceObserver.observe(layer, {
                subtree: true, childList: true, characterData: true, attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'lang', 'dir'],
            });
        }
        if (player) {
            playerObserver.observe(player, { attributes: true, attributeFilter: ['class', 'style'] });
            sizeObserver.observe(player);
        }
        const watch = player?.closest('ytd-watch-flexy');
        if (watch) {
            playerObserver.observe(watch, {
                attributes: true, attributeFilter: ['theater', 'fullscreen', 'hidden', 'miniplayer'],
            });
        }
    }

    function destination(player) {
        const watch = player.closest('ytd-watch-flexy');
        if (!watch || watch.hidden || watch.hasAttribute('miniplayer')) return null;
        if (watch.hasAttribute('theater')) {
            const theater = watch.querySelector('#player-theater-container, #full-bleed-container');
            if (theater?.contains(player)) return theater;
        }
        const regular = watch.querySelector('#primary-inner > #player')
            || watch.querySelector('#primary #player');
        return regular?.contains(player) ? regular : null;
    }

    function placeHost(anchor) {
        const parent = anchor.parentElement;
        if (host.parentElement === parent && anchor.nextElementSibling === host) return;
        const reference = anchor.nextSibling;
        if (host.isConnected && typeof parent.moveBefore === 'function') {
            parent.moveBefore(host, reference);
        } else {
            parent.insertBefore(host, reference);
        }
    }

    function readLines(panel) {
        return lineIds.flatMap((id, index) => {
            const node = panel.querySelector(`#${id}`);
            if (!node || node.hidden || !node.textContent.trim()) return [];
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return [];
            return [{
                text: node.textContent,
                original: index === 0,
                lang: node.lang,
                dir: node.dir || 'auto',
                order: style.order,
                color: style.color,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
            }];
        });
    }

    function render(lines) {
        const signature = JSON.stringify([dictionaryEnabled, lines]);
        if (signature === lastSignature) return;
        lastSignature = signature;
        const nodes = lines.map(line => {
            const node = document.createElement('div');
            node.className = 'line';
            node.lang = line.lang;
            node.dir = line.dir;
            for (const property of ['order', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight']) {
                node.style[property] = line[property];
            }
            if (dictionaryEnabled && line.original) {
                for (const part of line.text.split(/([A-Za-z]+(?:['’\-][A-Za-z]+)*)/)) {
                    if (/^[A-Za-z]/.test(part)) {
                        const word = document.createElement('a');
                        word.className = 'word';
                        word.textContent = part;
                        word.href = dictionaryUrl(part);
                        word.target = 'FluentReadDictionary';
                        word.rel = 'noopener noreferrer';
                        node.append(word);
                    } else {
                        node.append(document.createTextNode(part));
                    }
                }
            } else {
                node.textContent = line.text;
            }
            return node;
        });
        content.replaceChildren(...nodes);
    }

    function dictionaryUrl(word) {
        return `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(word)}`;
    }

    function lookupWord(event) {
        const word = event.target.closest('.word');
        if (!dictionaryEnabled || !word || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (host.shadowRoot.getSelection?.()?.toString() || window.getSelection()?.toString()) return;
        event.preventDefault();
        const width = Math.min(750, screen.availWidth);
        const height = Math.min(window.outerHeight || 900, screen.availHeight);
        const left = Math.max(0, screen.availWidth - width);
        const popup = window.open(word.href, 'FluentReadDictionary',
            `popup=yes,width=${width},height=${height},left=${left},top=0`);
        if (popup) {
            try { popup.opener = null; } catch { /* Cross-origin window. */ }
            sourcePlayer?.querySelector('video')?.pause();
        }
    }

    function update() {
        frame = 0;
        const panel = document.getElementById(panelId);
        const player = document.getElementById('movie_player');
        bindSource(panel, player);
        const anchor = player && destination(player);
        const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
        if (!enabled || location.pathname !== '/watch' || fullscreen || !panel || !anchor
            || player.classList.contains('ytp-player-minimized')
            || !player.getBoundingClientRect().width) {
            restoreOverlay();
            return;
        }
        const panelStyle = getComputedStyle(panel);
        const layerStyle = getComputedStyle(sourceLayer);
        if (panelStyle.display === 'none' || panelStyle.visibility !== 'visible'
            || layerStyle.display === 'none' || layerStyle.visibility !== 'visible') {
            restoreOverlay();
            return;
        }
        if (!host) createHost();
        placeHost(anchor);
        render(readLines(panel));
        host.hidden = false;
        sourceLayer.setAttribute(hiddenAttribute, '');
    }

    GM_registerMenuCommand('字幕下移 开启/关闭', () => {
        enabled = !enabled;
        GM_setValue('belowVideoEnabled', enabled);
        schedule();
    });
    GM_registerMenuCommand('点击英文单词查词 开启/关闭', () => {
        dictionaryEnabled = !dictionaryEnabled;
        GM_setValue('openDictionary', dictionaryEnabled);
        schedule();
    });

    new MutationObserver(records => {
        if (records.some(record => !host?.contains(record.target))) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    for (const name of ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'fullscreenchange', 'webkitfullscreenchange']) {
        document.addEventListener(name, () => {
            if (name === 'yt-navigate-start') restoreOverlay();
            schedule();
        });
    }
    window.addEventListener('resize', schedule, { passive: true });
    // Detect extension enable/disable and player replacements even without navigation events.
    window.setInterval(schedule, 1000);
    schedule();
})();
