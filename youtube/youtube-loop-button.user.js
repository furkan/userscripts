// ==UserScript==
// @name         YouTube Loop Button
// @description  Adds a one-click loop toggle to the YouTube player controls, leftmost on the right side.
// @version      1.0.5
// @match        *://www.youtube.com/*
// @run-at       document-idle
// ==/UserScript==

(() => {
  const BUTTON_CLASS = "ytlb-button";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Built with DOM calls: YouTube enforces Trusted Types, so assigning an
  // HTML string to innerHTML throws.
  function createIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z");
    svg.appendChild(path);
    return svg;
  }

  const style = document.createElement("style");
  style.textContent = `
    .ytp-button.${BUTTON_CLASS} {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: top;
    }
    .ytp-button.${BUTTON_CLASS} svg {
      width: 24px;
      height: 24px;
      fill: #fff;
      opacity: 0.6;
      transition: opacity 0.1s;
    }
    .ytp-button.${BUTTON_CLASS}[aria-pressed="true"] svg { opacity: 1; }
    /* Hover text styled like the player's own tooltips. */
    .ytlb-tooltip {
      position: absolute;
      z-index: 1002;
      padding: 5px 9px;
      border-radius: 4px;
      background: rgba(28, 28, 28, 0.9);
      color: #eee;
      font: 500 13px/15px "YouTube Noto", Roboto, Arial, sans-serif;
      white-space: nowrap;
      pointer-events: none;
      display: none;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const getVideo = (player) => player.querySelector("video.html5-main-video") || player.querySelector("video");

  function sync(player) {
    const button = player.querySelector("." + BUTTON_CLASS);
    const video = getVideo(player);
    if (!button || !video) return;
    const on = video.loop;
    button.setAttribute("aria-pressed", String(on));
    const label = on ? "Loop is on" : "Loop is off";
    button.setAttribute("aria-label", label);
    const tooltip = player.querySelector(".ytlb-tooltip");
    // Only write on change: writing text is a DOM mutation, which would
    // re-trigger the observer below every frame.
    if (tooltip && tooltip.textContent !== label) tooltip.textContent = label;
  }

  function showTooltip(player, button) {
    let tooltip = player.querySelector(".ytlb-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "ytlb-tooltip";
      player.appendChild(tooltip);
    }
    sync(player);
    tooltip.style.display = "block";
    // Center above the button, kept inside the player.
    const p = player.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    const left = Math.min(Math.max(b.left - p.left + b.width / 2 - t.width / 2, 8), p.width - t.width - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${b.top - p.top - t.height - 12}px`;
  }

  function hideTooltip(player) {
    const tooltip = player.querySelector(".ytlb-tooltip");
    if (tooltip) tooltip.style.display = "none";
  }

  function ensureButton(player) {
    const right = player.querySelector(".ytp-right-controls");
    if (!right) return;

    let button = player.querySelector("." + BUTTON_CLASS);
    if (!button) {
      button = document.createElement("button");
      button.className = `ytp-button ${BUTTON_CLASS}`;
      button.appendChild(createIcon());
      button.addEventListener("mouseenter", () => showTooltip(player, button));
      button.addEventListener("focus", () => showTooltip(player, button));
      button.addEventListener("mouseleave", () => hideTooltip(player));
      button.addEventListener("blur", () => hideTooltip(player));
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        const video = getVideo(player);
        if (!video) return;
        // Same thing the right-click "Loop" item does; YouTube's menu stays in sync.
        video.loop = !video.loop;
        sync(player);
      });
    }

    // Keep it leftmost on the right side (before autoplay). Newer players wrap
    // the right controls in sub-groups, so use the first group when present.
    // YouTube re-renders the controls, so re-place it if it moved.
    const group = right.querySelector(".ytp-right-controls-left") || right;
    if (group.firstElementChild !== button) group.prepend(button);
    sync(player);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      document.querySelectorAll(".html5-video-player").forEach(ensureButton);
    });
  }

  // Covers player creation, control re-renders, SPA navigation, and loop
  // changes from the right-click menu (the `loop` attribute is reflected).
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["loop"],
  });
  document.addEventListener("yt-navigate-finish", schedule);
  schedule();
})();
