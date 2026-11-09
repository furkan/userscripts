// ==UserScript==
// @name         ChatGPT Bulk Delete
// @description  Adds a panel for selecting and deleting many ChatGPT conversations at once, including chats in Projects.
// @version      1.1.0
// @match        https://chatgpt.com/*
// @run-at       document-idle
// ==/UserScript==

(() => {
  const PREFIX = "cgbd";
  const PAGE_SIZE = 100;
  const DELETE_DELAY_MS = 250; // Pause between deletes to stay clear of rate limits.
  const NO_PROJECT = "__none__";

  // ---------- API ----------
  // Same endpoints the web app itself uses. Undocumented, so they may change.

  let token = null;
  async function getToken() {
    if (token) return token;
    const res = await fetch("/api/auth/session", { credentials: "include" });
    if (!res.ok) throw new Error(`Session request failed (${res.status})`);
    const data = await res.json();
    if (!data.accessToken) throw new Error("Not logged in");
    token = data.accessToken;
    return token;
  }

  async function api(path, options = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(path, {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getToken()}`,
          ...(options.headers || {}),
        },
      });
      if (res.status === 401 && attempt === 0) {
        token = null; // Token expired; fetch a fresh one and retry once.
        continue;
      }
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get("Retry-After")) * 1000 || 2000 * 2 ** attempt;
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    }
  }

  // Chats outside Projects: offset-paginated.
  async function fetchMainConversations(onProgress) {
    const all = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await api(`/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`);
      const items = page.items || [];
      all.push(...items);
      onProgress(all.length);
      if (items.length < PAGE_SIZE || (page.total != null && all.length >= page.total)) break;
    }
    return all;
  }

  // Walks a cursor-paginated endpoint, stopping if the server repeats a cursor.
  async function fetchCursorPages(buildPath, firstCursor, onPage) {
    const seen = new Set();
    let cursor = firstCursor;
    do {
      const page = await api(buildPath(cursor));
      onPage(page.items || []);
      cursor = page.cursor;
      if (cursor != null) {
        if (seen.has(String(cursor))) break;
        seen.add(String(cursor));
      }
    } while (cursor != null);
  }

  // Projects are "snorlax" gizmos; the sidebar endpoint lists them.
  async function fetchProjects() {
    const projects = [];
    await fetchCursorPages(
      (cursor) => `/backend-api/gizmos/snorlax/sidebar${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      null,
      (items) => {
        for (const item of items) {
          const g = item?.gizmo?.gizmo || item?.gizmo || item;
          if (g?.id) projects.push({ id: g.id, name: g.display?.name || g.name || "Untitled project" });
        }
      },
    );
    return projects;
  }

  async function fetchProjectConversations(projectId) {
    const all = [];
    await fetchCursorPages(
      (cursor) => `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}`,
      "0",
      (items) => all.push(...items),
    );
    return all;
  }

  // What the menu's Delete does: a soft delete that hides the conversation.
  // Works the same for chats inside Projects.
  const deleteConversation = (id) =>
    api(`/backend-api/conversation/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_visible: false }),
    });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Theme ----------
  // ChatGPT's own theme marker isn't reliable to target from CSS, so work it out
  // from the page and stamp it on our elements as data-theme.

  function luminance(color) {
    const m = color.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null; // Unparsable or transparent.
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function isDark() {
    const html = document.documentElement;
    if (html.classList.contains("dark")) return true;
    if (html.classList.contains("light")) return false;
    const attr = `${html.dataset.theme || ""} ${html.dataset.colorScheme || ""}`.toLowerCase();
    if (attr.includes("dark")) return true;
    if (attr.includes("light")) return false;
    // Fall back to what is actually painted.
    for (const node of [document.querySelector("main"), document.body, html]) {
      if (!node) continue;
      const l = luminance(getComputedStyle(node).backgroundColor);
      if (l != null) return l < 0.5;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme() {
    const theme = isDark() ? "dark" : "light";
    document.querySelectorAll(`.${PREFIX}-root`).forEach((node) => {
      if (node.dataset.theme !== theme) node.dataset.theme = theme;
    });
  }

  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  // ---------- Styles ----------

  const style = document.createElement("style");
  style.textContent = `
    .${PREFIX}-root {
      --bg: #ffffff; --fg: #0d0d0d; --muted: #6b6b6b; --line: #e5e5e5; --hover: #f4f4f4;
      --accent: #2563eb; --accent-fg: #ffffff; --selected: rgba(37, 99, 235, .10);
      --tag: #f0f0f0; --warn: #b54708;
      --danger: #d92d20; --danger-fg: #ffffff; --backdrop: rgba(0, 0, 0, .4);
      color-scheme: light;
    }
    .${PREFIX}-root[data-theme="dark"] {
      --bg: #212121; --fg: #ececec; --muted: #a0a0a0; --line: #3a3a3a; --hover: #2c2c2c;
      --accent: #4c8dff; --accent-fg: #ffffff; --selected: rgba(76, 141, 255, .20);
      --tag: #333333; --warn: #f5a524;
      --danger: #e5484d; --danger-fg: #ffffff; --backdrop: rgba(0, 0, 0, .6);
      color-scheme: dark;
    }
    .${PREFIX}-root, .${PREFIX}-root * { box-sizing: border-box; }
    .${PREFIX}-launch {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line);
      background: var(--bg); color: var(--fg); font: 500 13px/1 system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .15); opacity: .75;
    }
    .${PREFIX}-launch:hover { opacity: 1; }
    .${PREFIX}-backdrop {
      position: fixed; inset: 0; z-index: 2147483001; background: var(--backdrop);
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .${PREFIX}-modal {
      width: min(760px, 100%); max-height: min(80vh, 800px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border-radius: 12px; border: 1px solid var(--line);
      font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 10px 40px rgba(0, 0, 0, .3);
    }
    .${PREFIX}-bar {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    .${PREFIX}-foot { border-bottom: 0; border-top: 1px solid var(--line); }
    .${PREFIX}-title { font-weight: 600; font-size: 16px; margin-right: auto; }
    .${PREFIX}-field {
      padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line);
      background: var(--bg); color: var(--fg); font: inherit; height: 32px;
    }
    .${PREFIX}-search { flex: 1; min-width: 160px; }
    .${PREFIX}-label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); }
    .${PREFIX}-warning { padding: 8px 16px; color: var(--warn); font-size: 13px; border-bottom: 1px solid var(--line); }
    .${PREFIX}-list { overflow-y: auto; flex: 1; min-height: 120px; }
    .${PREFIX}-row {
      display: flex; gap: 10px; align-items: center; padding: 7px 16px; cursor: pointer; user-select: none;
      border-left: 3px solid transparent;
    }
    .${PREFIX}-row:hover { background: var(--hover); }
    .${PREFIX}-row[aria-checked="true"] { background: var(--selected); border-left-color: var(--accent); }
    .${PREFIX}-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .${PREFIX}-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${PREFIX}-tag {
      flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 1px 8px; border-radius: 999px; background: var(--tag); color: var(--muted); font-size: 12px;
    }
    .${PREFIX}-date { flex: none; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .${PREFIX}-status { color: var(--muted); padding: 24px 16px; text-align: center; }
    .${PREFIX}-count { color: var(--muted); margin-right: auto; }
    /* Custom checkbox: ChatGPT's global styles flatten native ones. */
    .${PREFIX}-check {
      flex: none; width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--muted);
      display: inline-flex; align-items: center; justify-content: center; background: transparent;
    }
    [aria-checked="true"] > .${PREFIX}-check, [aria-checked="mixed"] > .${PREFIX}-check {
      background: var(--accent); border-color: var(--accent);
    }
    [aria-checked="true"] > .${PREFIX}-check::after {
      content: ""; width: 4px; height: 8px; margin-top: -2px;
      border: solid var(--accent-fg); border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
    [aria-checked="mixed"] > .${PREFIX}-check::after {
      content: ""; width: 8px; height: 2px; background: var(--accent-fg);
    }
    .${PREFIX}-btn {
      padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line); height: 32px;
      background: var(--bg); color: var(--fg); font: 500 13px/1 system-ui, sans-serif; cursor: pointer;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .${PREFIX}-btn:hover:not(:disabled) { background: var(--hover); }
    .${PREFIX}-btn:disabled { opacity: .5; cursor: default; }
    .${PREFIX}-danger { background: var(--danger); border-color: var(--danger); color: var(--danger-fg); }
    .${PREFIX}-danger:hover:not(:disabled) { background: var(--danger); filter: brightness(1.1); }
  `;
  document.head.appendChild(style);

  // ---------- DOM helper ----------
  // Built with DOM calls rather than innerHTML so titles are never parsed as HTML.

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) node.append(c);
    return node;
  }

  const check = () => el("span", { class: `${PREFIX}-check`, "aria-hidden": "true" });

  // ---------- Panel ----------

  const state = {
    conversations: [], // { id, title, update_time, projectId, projectName }
    projects: [], // { id, name }
    selected: new Set(),
    shown: [], // Conversations currently listed, in order.
    rows: new Map(), // id -> row element
    lastClickedIndex: null,
    busy: false,
  };

  let ui = null;

  // update_time comes back as an ISO string or a Unix timestamp depending on endpoint.
  function toSeconds(t) {
    if (t == null) return 0;
    return typeof t === "number" ? t : Date.parse(t) / 1000 || 0;
  }

  function formatDate(t) {
    const s = toSeconds(t);
    return s ? new Date(s * 1000).toLocaleDateString() : "";
  }

  function filterConversations() {
    const q = ui.search.value.trim().toLowerCase();
    const before = ui.before.value ? new Date(ui.before.value + "T00:00:00").getTime() / 1000 : null;
    const where = ui.project.value;
    return state.conversations.filter((c) => {
      if (q && !(c.title || "").toLowerCase().includes(q)) return false;
      if (before != null && toSeconds(c.update_time) >= before) return false;
      if (where === NO_PROJECT && c.projectId) return false;
      if (where && where !== NO_PROJECT && c.projectId !== where) return false;
      return true;
    });
  }

  function renderProjectOptions() {
    const current = ui.project.value;
    const options = [el("option", { value: "", textContent: "All chats" })];
    if (state.projects.length) {
      options.push(el("option", { value: NO_PROJECT, textContent: "Not in a project" }));
      for (const p of state.projects) options.push(el("option", { value: p.id, textContent: `Project: ${p.name}` }));
    }
    ui.project.replaceChildren(...options);
    ui.project.value = [...ui.project.options].some((o) => o.value === current) ? current : "";
  }

  function toggle(c, index, shiftKey) {
    if (state.busy) return;
    const select = !state.selected.has(c.id);
    // Shift-click selects or clears the whole range since the last click.
    const range =
      shiftKey && state.lastClickedIndex != null
        ? state.shown.slice(Math.min(state.lastClickedIndex, index), Math.max(state.lastClickedIndex, index) + 1)
        : [c];
    for (const item of range) select ? state.selected.add(item.id) : state.selected.delete(item.id);
    state.lastClickedIndex = index;
    updateSelection();
  }

  // Rebuilds the list. Only called when the set of shown conversations changes.
  function renderList() {
    state.shown = filterConversations();
    state.rows.clear();
    state.lastClickedIndex = null;
    ui.list.replaceChildren();
    ui.list.scrollTop = 0;

    if (!state.conversations.length) {
      ui.list.append(el("div", { class: `${PREFIX}-status`, textContent: ui.statusText || "No conversations." }));
    } else if (!state.shown.length) {
      ui.list.append(el("div", { class: `${PREFIX}-status`, textContent: "No conversations match." }));
    }

    state.shown.forEach((c, i) => {
      const children = [check(), el("span", { class: `${PREFIX}-row-title`, textContent: c.title || "Untitled", title: c.title || "" })];
      if (c.projectName) children.push(el("span", { class: `${PREFIX}-tag`, textContent: c.projectName, title: `Project: ${c.projectName}` }));
      children.push(el("span", { class: `${PREFIX}-date`, textContent: formatDate(c.update_time) }));

      const row = el("div", { class: `${PREFIX}-row`, role: "checkbox", tabIndex: 0 }, children);
      row.addEventListener("click", (e) => toggle(c, i, e.shiftKey));
      row.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggle(c, i, e.shiftKey);
        }
      });
      state.rows.set(c.id, row);
      ui.list.append(row);
    });

    updateSelection();
  }

  // Updates checkmarks, highlights and counts in place, keeping scroll position.
  function updateSelection() {
    for (const [id, row] of state.rows) row.setAttribute("aria-checked", String(state.selected.has(id)));

    const shownSelected = state.shown.filter((c) => state.selected.has(c.id)).length;
    const all = state.shown.length > 0 && shownSelected === state.shown.length;
    ui.selectAll.setAttribute("aria-checked", all ? "true" : shownSelected ? "mixed" : "false");
    ui.selectAll.disabled = state.busy || !state.shown.length;

    const n = state.selected.size;
    ui.count.textContent =
      ui.progressText || `${n} selected · ${state.shown.length} shown · ${state.conversations.length} total`;
    ui.del.disabled = state.busy || n === 0;
    ui.del.textContent = n ? `Delete ${n}` : "Delete";
    ui.refresh.disabled = ui.search.disabled = ui.before.disabled = ui.project.disabled = state.busy;
  }

  function setStatus(text) {
    ui.statusText = text;
    if (!state.conversations.length) renderList();
  }

  async function load() {
    state.busy = true;
    state.conversations = [];
    ui.warning.hidden = true;
    setStatus("Loading chats…");

    try {
      const byId = new Map();
      const main = await fetchMainConversations((n) => setStatus(`Loading chats… ${n}`));
      for (const c of main) byId.set(c.id, { id: c.id, title: c.title, update_time: c.update_time, projectId: null, projectName: null });

      // Projects are best-effort: if their endpoints fail, still show the other chats.
      try {
        setStatus("Loading projects…");
        state.projects = await fetchProjects();
        for (let i = 0; i < state.projects.length; i++) {
          const p = state.projects[i];
          setStatus(`Loading project chats… ${i + 1} of ${state.projects.length}`);
          for (const c of await fetchProjectConversations(p.id)) {
            byId.set(c.id, { id: c.id, title: c.title, update_time: c.update_time, projectId: p.id, projectName: p.name });
          }
        }
      } catch (err) {
        console.warn(`[${PREFIX}] Failed to load projects:`, err);
        state.projects = [];
        ui.warning.textContent = `Couldn't load chats in Projects (${err.message}). Only chats outside Projects are listed.`;
        ui.warning.hidden = false;
      }

      state.conversations = [...byId.values()].sort((a, b) => toSeconds(b.update_time) - toSeconds(a.update_time));
      // Drop selections for conversations that no longer exist.
      for (const id of state.selected) if (!byId.has(id)) state.selected.delete(id);
      ui.statusText = null;
    } catch (err) {
      ui.statusText = `Couldn't load conversations: ${err.message}`;
    } finally {
      state.busy = false;
      renderProjectOptions();
      renderList();
    }
  }

  async function deleteSelected() {
    const ids = [...state.selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} conversation${ids.length === 1 ? "" : "s"}? This can't be undone.`)) return;

    state.busy = true;
    const failed = [];
    for (let i = 0; i < ids.length; i++) {
      ui.progressText = `Deleting ${i + 1} of ${ids.length}…`;
      updateSelection();
      try {
        await deleteConversation(ids[i]);
        state.selected.delete(ids[i]);
        state.conversations = state.conversations.filter((c) => c.id !== ids[i]);
        state.rows.get(ids[i])?.remove();
        state.rows.delete(ids[i]);
        ui.deletedAny = true;
      } catch (err) {
        failed.push(ids[i]);
        console.warn(`[${PREFIX}] Failed to delete ${ids[i]}:`, err);
      }
      if (i < ids.length - 1) await sleep(DELETE_DELAY_MS);
    }
    state.busy = false;
    ui.progressText = null;
    renderList();

    if (failed.length) {
      alert(`${ids.length - failed.length} deleted, ${failed.length} failed. The failed ones are still selected; try again.`);
    }
  }

  function close() {
    if (state.busy) return;
    const deletedAny = ui.deletedAny;
    ui.backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    ui = null;
    // The sidebar keeps its own cached list, so reload to make deletions show up there.
    if (deletedAny) location.reload();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function open() {
    if (ui) return;
    const field = `${PREFIX}-field`;
    const search = el("input", { type: "search", class: `${field} ${PREFIX}-search`, placeholder: "Filter by title", oninput: () => renderList() });
    const before = el("input", { type: "date", class: field, title: "Only show chats last updated before this date", oninput: () => renderList() });
    const project = el("select", { class: field, title: "Filter by project", onchange: () => renderList() });
    const selectAll = el(
      "button",
      {
        class: `${PREFIX}-btn`,
        role: "checkbox",
        title: "Select or clear all shown",
        onclick: () => {
          const allSelected = state.shown.every((c) => state.selected.has(c.id));
          for (const c of state.shown) allSelected ? state.selected.delete(c.id) : state.selected.add(c.id);
          updateSelection();
        },
      },
      [check(), "All"],
    );
    const warning = el("div", { class: `${PREFIX}-warning`, hidden: true });
    const list = el("div", { class: `${PREFIX}-list` });
    const count = el("span", { class: `${PREFIX}-count` });
    const refresh = el("button", { class: `${PREFIX}-btn`, textContent: "Refresh", onclick: load });
    const cancel = el("button", { class: `${PREFIX}-btn`, textContent: "Close", onclick: close });
    const del = el("button", { class: `${PREFIX}-btn ${PREFIX}-danger`, textContent: "Delete", onclick: deleteSelected });

    const modal = el("div", { class: `${PREFIX}-modal`, role: "dialog", "aria-modal": "true", "aria-label": "Bulk delete conversations" }, [
      el("div", { class: `${PREFIX}-bar` }, [el("div", { class: `${PREFIX}-title`, textContent: "Bulk delete conversations" }), refresh]),
      el("div", { class: `${PREFIX}-bar` }, [selectAll, search, project, el("label", { class: `${PREFIX}-label` }, ["Updated before", before])]),
      warning,
      list,
      el("div", { class: `${PREFIX}-bar ${PREFIX}-foot` }, [count, cancel, del]),
    ]);

    const backdrop = el("div", { class: `${PREFIX}-root ${PREFIX}-backdrop` }, modal);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    ui = { backdrop, search, before, project, selectAll, warning, list, count, refresh, del, statusText: null, progressText: null, deletedAny: false };
    renderProjectOptions();
    document.body.append(backdrop);
    applyTheme();
    document.addEventListener("keydown", onKey, true);
    search.focus();
    load();
  }

  // ---------- Launcher ----------
  // ChatGPT re-renders large parts of the page, so put the button back if it gets removed.

  function ensureLauncher() {
    if (document.querySelector(`.${PREFIX}-launch`)) return;
    document.body.append(
      el("button", {
        class: `${PREFIX}-root ${PREFIX}-launch`,
        textContent: "Bulk delete",
        title: "Select and delete many conversations",
        onclick: open,
      }),
    );
    applyTheme();
  }

  new MutationObserver(ensureLauncher).observe(document.body, { childList: true });
  ensureLauncher();
})();
