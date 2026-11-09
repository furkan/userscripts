// ==UserScript==
// @name         Reddit → Redlib
// @description  Redirect Reddit URLs to redlib.catsarch.com
// @match        *://reddit.com/*
// @match        *://*.reddit.com/*
// @run-at       document-start
// ==/UserScript==

(() => {
    const target = 'redlib.catsarch.com';

    if (
        location.hostname === 'reddit.com' ||
        location.hostname.endsWith('.reddit.com')
    ) {
        const url = new URL(location.href);
        url.hostname = target;
        url.protocol = 'https:';
        location.replace(url.href);
    }
})();
