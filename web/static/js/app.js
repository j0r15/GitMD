(function () {
  "use strict";

  var md = window.markdownit({ html: false, linkify: true, typographer: true });

  var state = {
    repos: [],
    currentRepoId: null,
    currentPath: null,
    dirty: false,
    isNewFile: false,
    viewMode: "both",
  };

  var els = {
    loginOverlay: document.getElementById("login-overlay"),
    loginForm: document.getElementById("login-form"),
    loginPassword: document.getElementById("login-password"),
    loginError: document.getElementById("login-error"),
    app: document.getElementById("app"),
    repoSelect: document.getElementById("repo-select"),
    repoBranch: document.getElementById("repo-branch"),
    currentPathEl: document.getElementById("current-path"),
    dirtyDot: document.getElementById("dirty-dot"),
    statusMsg: document.getElementById("status-msg"),
    btnSave: document.getElementById("btn-save"),
    btnLogout: document.getElementById("btn-logout"),
    btnNew: document.getElementById("btn-new"),
    btnSidebar: document.getElementById("btn-sidebar"),
    viewModes: document.getElementById("view-modes"),
    fileTree: document.getElementById("file-tree"),
    emptyState: document.getElementById("empty-state"),
    panes: document.getElementById("panes"),
    panePreview: document.getElementById("pane-preview"),
    preview: document.getElementById("preview"),
    previewFrame: document.getElementById("preview-frame"),
    sourceToolbar: document.getElementById("source-toolbar"),
    btnTable: document.getElementById("btn-table"),
    tablePicker: document.getElementById("table-picker"),
    tableGrid: document.getElementById("table-grid"),
    tablePickerLabel: document.getElementById("table-picker-label"),
    sbCursor: document.getElementById("sb-cursor"),
    sbLines: document.getElementById("sb-lines"),
    sbWords: document.getElementById("sb-words"),
    modalOverlay: document.getElementById("modal-overlay"),
    modalTitle: document.getElementById("modal-title"),
    modalInput: document.getElementById("modal-input"),
    modalError: document.getElementById("modal-error"),
    modalCancel: document.getElementById("modal-cancel"),
    modalConfirm: document.getElementById("modal-confirm"),
  };

  var cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
    mode: "markdown",
    lineNumbers: true,
    lineWrapping: true,
    theme: "gitmd-dark",
    indentUnit: 4,
    placeholder: "Start writing...",
    extraKeys: {
      "Ctrl-S": function () { save(); },
      "Cmd-S": function () { save(); },
      "Ctrl-B": function () { SOURCE_COMMANDS.bold(); },
      "Cmd-B": function () { SOURCE_COMMANDS.bold(); },
      "Ctrl-I": function () { SOURCE_COMMANDS.italic(); },
      "Cmd-I": function () { SOURCE_COMMANDS.italic(); },
      Enter: "newlineAndIndentContinueMarkdownList",
    },
  });
  // newlineAndIndentContinueMarkdownList comes from an addon we don't ship;
  // fall back to a plain newline if it's missing.
  if (!CodeMirror.commands.newlineAndIndentContinueMarkdownList) {
    CodeMirror.commands.newlineAndIndentContinueMarkdownList = CodeMirror.commands.newlineAndIndent;
  }

  // --- small helpers ---

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        showLogin();
        return Promise.reject(new Error("not authenticated"));
      }
      return res.json().then(function (data) {
        if (!res.ok) {
          return Promise.reject(new Error(data.error || res.statusText));
        }
        return data;
      });
    });
  }

  var statusTimer = null;
  function setStatus(msg, kind) {
    clearTimeout(statusTimer);
    els.statusMsg.textContent = msg || "";
    els.statusMsg.classList.toggle("error", kind === "error");
    els.statusMsg.classList.toggle("ok", kind === "ok");
    if (kind === "ok") {
      statusTimer = setTimeout(function () { setStatus(""); }, 2500);
    }
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  // Renders "dir/sub/" muted and the file name in full weight.
  function renderPathInto(el, path) {
    el.textContent = "";
    if (!path) return;
    var idx = path.lastIndexOf("/");
    if (idx >= 0) {
      var dir = document.createElement("span");
      dir.className = "dir";
      dir.textContent = path.slice(0, idx + 1);
      el.appendChild(dir);
    }
    el.appendChild(document.createTextNode(path.slice(idx + 1)));
  }

  function setCurrentPath(path) {
    renderPathInto(els.currentPathEl, path);
    els.currentPathEl.title = path || "";
    updateTitle();
    syncUrl(!applyingUrlState);
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    els.dirtyDot.hidden = !dirty;
    els.btnSave.disabled = !dirty || !state.currentPath;
    updateTitle();
  }

  function updateTitle() {
    if (!state.currentPath) {
      document.title = "gitmd";
      return;
    }
    var name = state.currentPath.split("/").pop();
    document.title = (state.dirty ? "• " : "") + name + " - gitmd";
  }

  // --- preview ---

  // markdown-it plus GitHub-style task lists ("- [ ]" / "- [x]"), done on the
  // rendered HTML since we don't ship the task-list plugin.
  function renderMarkdown(src) {
    return md.render(src).replace(
      /<li>(<p>)?\[([ xX])\]\s/g,
      function (_, p, mark) {
        var checked = mark === " " ? "" : " checked";
        return '<li class="task-list-item">' + (p || "") + '<input type="checkbox" disabled' + checked + "> ";
      }
    );
  }

  var previewTimer = null;
  function schedulePreview() {
    var hugo = isHugoRepo();
    els.preview.hidden = hugo;
    els.previewFrame.hidden = !hugo;
    if (hugo) {
      scheduleHugoBuild();
      return;
    }
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      els.preview.innerHTML = renderMarkdown(cm.getValue());
      syncPreviewScroll();
    }, 150);
  }

  // --- hugo site preview ---
  //
  // For repos configured with type: hugo, the preview pane shows the real
  // hugo-rendered page (in an iframe) instead of the built-in markdown
  // renderer. Editing debounces a rebuild rather than firing on every
  // keystroke, since each one is a real `hugo` subprocess run.

  // Best-effort mapping from a content file's repo path to the URL it
  // renders at. contentDir is the site's actual resolved hugo contentDir
  // (from the build response — sites can override the "content" default,
  // e.g. to "docs"). Doesn't know about custom permalinks, slugs, or
  // aliases set in front matter — falls back to the nearest guess rather
  // than failing outright. Also lowercases each segment: hugo's default
  // URL generation lowercases paths derived from file/directory names
  // (a site with disablePathToLower set is the one case this guess gets
  // wrong on casing).
  function hugoUrlForPath(path, contentDir) {
    var prefix = new RegExp("^" + (contentDir || "content").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/");
    var parts = path.replace(prefix, "").split("/");
    var last = parts[parts.length - 1];
    if (/^_?index\.(md|markdown)$/i.test(last)) {
      parts = parts.slice(0, -1);
    } else {
      parts[parts.length - 1] = last.replace(/\.(md|markdown)$/i, "");
    }
    parts = parts.filter(function (p) { return p !== ""; }).map(function (p) { return p.toLowerCase(); });
    return parts.length ? "/" + parts.join("/") + "/" : "/";
  }

  var hugoBuildTimer = null;
  function scheduleHugoBuild() {
    clearTimeout(hugoBuildTimer);
    hugoBuildTimer = setTimeout(buildAndShowHugoPreview, 600);
  }

  function buildAndShowHugoPreview() {
    if (!isHugoRepo() || !state.currentPath) return;
    var repoId = state.currentRepoId;
    var path = state.currentPath;
    setStatus("Building site…");
    api("/api/repos/" + encodeURIComponent(repoId) + "/build", {
      method: "POST",
      body: JSON.stringify({ path: path, content: cm.getValue() }),
    })
      .then(function (data) {
        // The user may have switched repo/file while the build ran.
        if (state.currentRepoId !== repoId || state.currentPath !== path) return;
        setStatus("");
        els.previewFrame.src = data.previewUrl.replace(/\/$/, "") + hugoUrlForPath(path, data.contentDir) + "?_=" + Date.now();
      })
      .catch(function (err) {
        setStatus("Hugo build failed: " + err.message, "error");
      });
  }

  // Proportional scroll sync: editor drives the preview.
  function syncPreviewScroll() {
    if (state.viewMode !== "both" || isHugoRepo()) return;
    var info = cm.getScrollInfo();
    var max = info.height - info.clientHeight;
    var ratio = max > 0 ? info.top / max : 0;
    var p = els.panePreview;
    p.scrollTop = ratio * (p.scrollHeight - p.clientHeight);
  }
  cm.on("scroll", syncPreviewScroll);

  // --- source formatting toolbar ---
  //
  // These all operate directly on the plain-text markdown in `cm` — there's
  // no separate rich-text buffer to keep in sync, so a click just edits the
  // source the same way typing would.

  // Wraps the selection in `before`/`after` (e.g. "**"/"**" for bold). With
  // no selection, inserts `defaultText` and selects it so typing replaces it.
  function wrapSelection(before, after, defaultText) {
    after = after == null ? before : after;
    var from = cm.getCursor("from");
    var to = cm.getCursor("to");
    var selected = cm.getRange(from, to);
    var placeholder = selected || defaultText || "text";
    cm.replaceRange(before + placeholder + after, from, to);
    var markerEnd = posAfterInsert(from, before);
    var placeholderEnd = posAfterInsert(markerEnd, placeholder);
    cm.setSelection(markerEnd, placeholderEnd);
    cm.focus();
  }

  // Where the cursor ends up after inserting `text` at `start`.
  function posAfterInsert(start, text) {
    var lines = text.split("\n");
    if (lines.length === 1) return { line: start.line, ch: start.ch + lines[0].length };
    return { line: start.line + lines.length - 1, ch: lines[lines.length - 1].length };
  }

  // Toggles a per-line prefix (blockquote, bullet list) across the
  // selected lines: strips it if every selected line already has it,
  // otherwise adds it to each.
  function toggleLinePrefix(stripRegex, prefix) {
    var from = cm.getCursor("from").line;
    var to = cm.getCursor("to").line;
    var allHavePrefix = true;
    for (var l = from; l <= to; l++) {
      if (!stripRegex.test(cm.getLine(l))) { allHavePrefix = false; break; }
    }
    cm.operation(function () {
      for (var l = from; l <= to; l++) {
        var line = cm.getLine(l);
        var stripped = line.replace(stripRegex, "");
        var next = allHavePrefix ? stripped : prefix + stripped;
        cm.replaceRange(next, { line: l, ch: 0 }, { line: l, ch: line.length });
      }
    });
    cm.focus();
  }

  // Headings replace any existing "#" marker rather than stacking, so
  // clicking H2 on an H1 line converts it instead of leaving "# ## ".
  function toggleHeading(level) {
    var marker = new Array(level + 1).join("#") + " ";
    var from = cm.getCursor("from").line;
    var to = cm.getCursor("to").line;
    var allMatch = true;
    for (var l = from; l <= to; l++) {
      if (cm.getLine(l).indexOf(marker) !== 0) { allMatch = false; break; }
    }
    cm.operation(function () {
      for (var l = from; l <= to; l++) {
        var line = cm.getLine(l);
        var stripped = line.replace(/^#{1,6}\s+/, "");
        var next = allMatch ? stripped : marker + stripped;
        cm.replaceRange(next, { line: l, ch: 0 }, { line: l, ch: line.length });
      }
    });
    cm.focus();
  }

  function toggleOrderedList() {
    var from = cm.getCursor("from").line;
    var to = cm.getCursor("to").line;
    var allHaveNumbers = true;
    for (var l = from; l <= to; l++) {
      if (!/^\d+\.\s+/.test(cm.getLine(l))) { allHaveNumbers = false; break; }
    }
    cm.operation(function () {
      var n = 1;
      for (var l = from; l <= to; l++) {
        var line = cm.getLine(l);
        var stripped = line.replace(/^\d+\.\s+/, "");
        var next = allHaveNumbers ? stripped : (n++) + ". " + stripped;
        cm.replaceRange(next, { line: l, ch: 0 }, { line: l, ch: line.length });
      }
    });
    cm.focus();
  }

  // Inserts a block (horizontal rule) at the cursor with a blank line on
  // either side, unless one's already there.
  function insertBlock(text) {
    var cur = cm.getCursor();
    var before = cm.getRange({ line: 0, ch: 0 }, cur);
    var afterPos = { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length };
    var after = cm.getRange(cur, afterPos);
    var prefix = before === "" || /\n\s*\n$/.test(before) ? "" : "\n\n";
    var suffix = after === "" || /^\s*\n/.test(after) ? "\n" : "\n\n";
    cm.replaceRange(prefix + text + suffix, cur);
    cm.focus();
  }

  function insertLink() {
    var url = window.prompt("Link URL:", "https://");
    if (!url) return;
    wrapSelection("[", "](" + url + ")", "link text");
  }

  function insertImage() {
    var url = window.prompt("Image URL:", "https://");
    if (!url) return;
    var from = cm.getCursor("from"), to = cm.getCursor("to");
    var alt = cm.getRange(from, to) || "alt text";
    cm.replaceRange("![" + alt + "](" + url + ")", from, to);
    cm.focus();
  }

  var SOURCE_COMMANDS = {
    bold: function () { wrapSelection("**"); },
    italic: function () { wrapSelection("_"); },
    strike: function () { wrapSelection("~~"); },
    h1: function () { toggleHeading(1); },
    h2: function () { toggleHeading(2); },
    h3: function () { toggleHeading(3); },
    quote: function () { toggleLinePrefix(/^>\s?/, "> "); },
    code: function () { wrapSelection("`"); },
    ul: function () { toggleLinePrefix(/^[-*]\s+/, "- "); },
    ol: toggleOrderedList,
    link: insertLink,
    image: insertImage,
    hr: function () { insertBlock("---"); },
    undo: function () { cm.undo(); cm.focus(); },
    redo: function () { cm.redo(); cm.focus(); },
  };

  els.sourceToolbar.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-cmd]");
    if (!btn) return;
    var fn = SOURCE_COMMANDS[btn.dataset.cmd];
    if (fn) fn();
  });

  // --- status bar ---

  function updateStatusBar() {
    var cur = cm.getCursor();
    els.sbCursor.textContent = "Line " + (cur.line + 1) + ", Column " + (cur.ch + 1);
    var lines = cm.lineCount();
    els.sbLines.textContent = "— " + lines + (lines === 1 ? " line" : " lines");
    var text = cm.getValue().trim();
    var words = text ? text.split(/\s+/).length : 0;
    els.sbWords.textContent = words + (words === 1 ? " word" : " words");
  }
  cm.on("cursorActivity", updateStatusBar);

  cm.on("change", function () {
    schedulePreview();
    updateStatusBar();
    if (state.currentPath) setDirty(true);
  });

  // --- view mode & sidebar ---

  function setViewMode(mode) {
    state.viewMode = mode;
    els.panes.dataset.mode = mode;
    Array.prototype.forEach.call(els.viewModes.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.dataset.mode === mode);
      b.setAttribute("aria-pressed", b.dataset.mode === mode ? "true" : "false");
    });
    storageSet("gitmd.viewMode", mode);
    if (mode !== "view") {
      cm.refresh();
      if (state.currentPath) cm.focus();
    }
    syncPreviewScroll();
    syncUrl(false);
  }

  function setViewModesEnabled(enabled) {
    Array.prototype.forEach.call(els.viewModes.querySelectorAll("button"), function (b) {
      b.disabled = !enabled;
    });
  }

  els.viewModes.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-mode]");
    if (btn && !btn.disabled) setViewMode(btn.dataset.mode);
  });

  function toggleSidebar() {
    var collapsed = els.app.classList.toggle("sidebar-collapsed");
    storageSet("gitmd.sidebar", collapsed ? "collapsed" : "open");
    cm.refresh();
  }
  els.btnSidebar.addEventListener("click", toggleSidebar);

  document.addEventListener("keydown", function (e) {
    if (els.app.hidden || !els.modalOverlay.hidden) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (mod && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
    } else if (mod && e.altKey && state.currentPath) {
      var modes = { e: "edit", b: "both", v: "view" };
      var mode = modes[e.code ? e.code.replace("Key", "").toLowerCase() : e.key.toLowerCase()];
      if (mode) {
        e.preventDefault();
        setViewMode(mode);
      }
    }
  });

  // --- auth ---

  function showLogin() {
    els.app.hidden = true;
    els.loginOverlay.hidden = false;
    els.loginPassword.focus();
  }

  function showApp() {
    els.loginOverlay.hidden = true;
    els.app.hidden = false;
    cm.refresh();
  }

  els.loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    els.loginError.hidden = true;
    api("/api/login", { method: "POST", body: JSON.stringify({ password: els.loginPassword.value }) })
      .then(function () {
        els.loginPassword.value = "";
        showApp();
        loadRepos();
      })
      .catch(function (err) {
        els.loginError.textContent = err.message;
        els.loginError.hidden = false;
      });
  });

  els.btnLogout.addEventListener("click", function () {
    if (!confirmDiscardIfDirty()) return;
    api("/api/logout", { method: "POST" }).then(function () {
      closeFile();
      state.currentRepoId = null;
      showLogin();
    });
  });

  // --- repos & tree ---

  function currentRepoInfo() {
    return state.repos.find(function (r) { return r.id === state.currentRepoId; });
  }

  function isHugoRepo() {
    var r = currentRepoInfo();
    return !!r && r.type === "hugo";
  }

  // --- URL routing ---
  //
  // The address bar mirrors the open document: /<repo>/<branch>/<path>?view=<mode>.
  // Branch is informational — gitmd only ever serves the one branch a repo
  // is configured with, so it's reflected in the URL but never used to
  // pick anything; routing only looks at the repo id and file path.

  var VIEW_MODES = ["edit", "both", "view"];

  function buildAppUrl(repoId, branch, path, viewMode) {
    var parts = [encodeURIComponent(repoId), encodeURIComponent(branch || "")];
    if (path) {
      path.split("/").forEach(function (seg) { parts.push(encodeURIComponent(seg)); });
    }
    return "/" + parts.join("/") + (path ? "" : "/") + "?view=" + viewMode;
  }

  // Splits the raw pathname on "/" before decoding each segment, so a "/"
  // that was encoded as %2F inside one segment (e.g. a branch name like
  // "feature/foo") doesn't get mistaken for a path separator.
  function parseAppUrl() {
    var segs = window.location.pathname.split("/").filter(function (s) { return s !== ""; }).map(decodeURIComponent);
    if (segs.length === 0) return null;
    var view = new URLSearchParams(window.location.search).get("view");
    return {
      repoId: segs[0],
      branch: segs[1] || "",
      path: segs.length > 2 ? segs.slice(2).join("/") : null,
      view: VIEW_MODES.indexOf(view) !== -1 ? view : null,
    };
  }

  // Keeps the address bar in sync with the open document. `push` adds a
  // new history entry (opening a different file/repo); otherwise the
  // current entry is just updated in place (e.g. toggling view mode).
  function syncUrl(push) {
    if (!state.currentRepoId) return;
    var repo = currentRepoInfo();
    var url = buildAppUrl(state.currentRepoId, repo && repo.branch, state.currentPath, state.viewMode);
    if (url === window.location.pathname + window.location.search) return;
    var fn = push ? "pushState" : "replaceState";
    history[fn](null, "", url);
  }

  // Applies a parsed URL (initial load or a back/forward navigation) to
  // the app: selects the repo, opens the file (or shows the empty state),
  // and sets the view mode. Returns false if the URL doesn't name a known
  // repo, so the caller can fall back to its own default.
  // True while applyUrlState is making the app match a URL that's already
  // in the address bar (initial load, or a back/forward navigation) —
  // setCurrentPath checks this to replaceState instead of pushState, so
  // we don't shove a duplicate history entry on top of the one the user
  // (or the browser) just navigated to.
  var applyingUrlState = false;

  function applyUrlState(urlState) {
    if (!urlState || !urlState.repoId) return false;
    var repo = state.repos.find(function (r) { return r.id === urlState.repoId; });
    if (!repo) return false;
    if (!confirmDiscardIfDirty()) {
      syncUrl(true); // the browser already moved the address bar; put it back
      return true;
    }

    applyingUrlState = true;
    function openTarget() {
      if (urlState.view) setViewMode(urlState.view);
      var opened = urlState.path ? openFile(urlState.path) : Promise.resolve(closeFile());
      opened.then(function () { applyingUrlState = false; });
    }

    if (state.currentRepoId === repo.id) {
      openTarget();
    } else {
      state.currentRepoId = repo.id;
      els.repoSelect.value = repo.id;
      updateRepoBranchLabel();
      loadTree().then(openTarget);
    }
    return true;
  }

  window.addEventListener("popstate", function () {
    if (!applyUrlState(parseAppUrl())) syncUrl(true);
  });

  function updateRepoBranchLabel() {
    var repo = currentRepoInfo();
    els.repoBranch.textContent = repo ? repo.branch : "";
  }

  function populateRepos(repos) {
    state.repos = repos;
    els.repoSelect.innerHTML = "";
    repos.forEach(function (r) {
      var opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      els.repoSelect.appendChild(opt);
    });
    if (applyUrlState(parseAppUrl())) return;
    if (repos.length > 0) {
      state.currentRepoId = repos[0].id;
      updateRepoBranchLabel();
      loadTree();
      syncUrl(true);
    }
  }

  function loadRepos() {
    api("/api/repos").then(populateRepos);
  }

  els.repoSelect.addEventListener("change", function () {
    if (!confirmDiscardIfDirty()) {
      els.repoSelect.value = state.currentRepoId;
      return;
    }
    state.currentRepoId = els.repoSelect.value;
    updateRepoBranchLabel();
    closeFile();
    loadTree();
  });

  function loadTree() {
    setStatus("Syncing…");
    return api("/api/repos/" + encodeURIComponent(state.currentRepoId) + "/tree")
      .then(function (files) {
        renderTree(files);
        setStatus("");
      })
      .catch(function (err) {
        setStatus(err.message, "error");
      });
  }

  var ICON_FILE = '<svg class="file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3.5 3.5v9.5h-8.5z"/><path d="M9 1.5V5h3.5"/></svg>';
  var ICON_FOLDER = '<svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4l1.5 2h7.5v7h-13z"/></svg>';
  var ICON_CHEVRON = '<svg class="tree-toggle" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L11 8l-5 4.5"/></svg>';
  var ICON_RENAME = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z"/></svg>';
  var ICON_DELETE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>';

  function iconButton(svg, label, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.innerHTML = svg;
    b.title = label;
    b.setAttribute("aria-label", label);
    if (cls) b.className = cls;
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // Groups the flat file list from the API into a dir/file tree, sorted
  // with directories first, then alphabetically within each level.
  function buildTree(files) {
    var root = { dirs: {}, files: [] };
    files.forEach(function (f) {
      var parts = f.path.split("/");
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var part = parts[i];
        if (!node.dirs[part]) node.dirs[part] = { name: part, dirs: {}, files: [] };
        node = node.dirs[part];
      }
      node.files.push({ name: parts[parts.length - 1], path: f.path });
    });
    return root;
  }

  function sortedKeys(obj) {
    return Object.keys(obj).sort(function (a, b) { return a.localeCompare(b); });
  }

  // Folders a user has collapsed, keyed by path; persists across tree
  // reloads (e.g. after a save) within the current session.
  var collapsedDirs = {};

  function createFileRow(path, name) {
    var li = document.createElement("li");
    li.title = path;
    li.dataset.path = path;
    if (path === state.currentPath) li.classList.add("active");

    li.insertAdjacentHTML("beforeend", ICON_FILE);
    var nameEl = document.createElement("span");
    nameEl.className = "file-name";
    nameEl.textContent = name;
    li.appendChild(nameEl);

    var actions = document.createElement("span");
    actions.className = "file-actions";
    actions.appendChild(iconButton(ICON_RENAME, "Rename", "", function () { promptRename(path); }));
    actions.appendChild(iconButton(ICON_DELETE, "Delete", "danger", function () { promptDelete(path); }));
    li.appendChild(actions);

    li.addEventListener("click", function () { openFile(path); });
    return li;
  }

  function renderDirNode(node, dirPath, parent) {
    sortedKeys(node.dirs).forEach(function (name) {
      var childPath = dirPath ? dirPath + "/" + name : name;
      var row = document.createElement("li");
      row.className = "tree-dir-row";
      row.dataset.dirPath = childPath;
      var collapsed = !!collapsedDirs[childPath];
      if (collapsed) row.classList.add("collapsed");

      row.insertAdjacentHTML("beforeend", ICON_CHEVRON);
      row.insertAdjacentHTML("beforeend", ICON_FOLDER);
      var nameEl = document.createElement("span");
      nameEl.className = "file-name";
      nameEl.textContent = name;
      row.appendChild(nameEl);

      var childUl = document.createElement("ul");
      childUl.className = "tree-children";

      row.addEventListener("click", function () {
        var nowCollapsed = row.classList.toggle("collapsed");
        collapsedDirs[childPath] = nowCollapsed;
      });

      parent.appendChild(row);
      parent.appendChild(childUl);
      renderDirNode(node.dirs[name], childPath, childUl);
    });

    sortedKeys(node.files.reduce(function (acc, f) { acc[f.name] = f; return acc; }, {}))
      .forEach(function (name) {
        var f = node.files.find(function (x) { return x.name === name; });
        parent.appendChild(createFileRow(f.path, f.name));
      });
  }

  function renderTree(files) {
    els.fileTree.innerHTML = "";
    renderDirNode(buildTree(files), "", els.fileTree);
  }

  function markActive(path) {
    Array.prototype.forEach.call(els.fileTree.querySelectorAll("li[data-path]"), function (li) {
      li.classList.toggle("active", li.dataset.path === path);
    });
  }

  // --- file open/save/close ---

  function confirmDiscardIfDirty() {
    if (!state.dirty) return true;
    return window.confirm("Discard unsaved changes to " + state.currentPath + "?");
  }

  function showEditor() {
    // On narrow screens the sidebar overlays the editor; get it out of the way.
    if (window.matchMedia("(max-width: 760px)").matches) els.app.classList.add("sidebar-collapsed");
    els.emptyState.hidden = true;
    els.panes.hidden = false;
    setViewModesEnabled(true);
    cm.refresh();
  }

  function openFile(path) {
    if (path === state.currentPath && !state.isNewFile) return Promise.resolve();
    if (!confirmDiscardIfDirty()) return Promise.resolve();
    setStatus("Loading…");
    return api("/api/repos/" + encodeURIComponent(state.currentRepoId) + "/file?path=" + encodeURIComponent(path))
      .then(function (data) {
        state.currentPath = data.path;
        state.isNewFile = false;
        cm.setValue(data.content);
        cm.clearHistory();
        setDirty(false);
        setCurrentPath(data.path);
        showEditor();
        schedulePreview();
        markActive(path);
        setStatus("");
        if (state.viewMode !== "view") cm.focus();
      })
      .catch(function (err) {
        setStatus(err.message, "error");
      });
  }

  function closeFile() {
    state.currentPath = null;
    state.isNewFile = false;
    cm.setValue("");
    setDirty(false);
    setCurrentPath(null);
    els.emptyState.hidden = false;
    els.panes.hidden = true;
    setViewModesEnabled(false);
  }

  function save() {
    if (!state.currentPath || !state.dirty) return;
    var defaultMsg = (state.isNewFile ? "Create " : "Update ") + state.currentPath;
    var message = window.prompt("Commit message:", defaultMsg);
    if (message === null) return; // cancelled
    setStatus("Saving…");
    els.btnSave.disabled = true;
    api("/api/repos/" + encodeURIComponent(state.currentRepoId) + "/file", {
      method: "PUT",
      body: JSON.stringify({ path: state.currentPath, content: cm.getValue(), message: message }),
    })
      .then(function () {
        state.isNewFile = false;
        setDirty(false);
        setStatus("Saved & pushed", "ok");
        loadTree();
      })
      .catch(function (err) {
        setStatus(err.message, "error");
        els.btnSave.disabled = false;
      });
  }

  els.btnSave.addEventListener("click", save);

  // --- table creator ---
  //
  // Inserts plain markdown table syntax directly into the source at the
  // cursor, same as the other toolbar commands.

  var TABLE_GRID_MAX = 8;

  (function buildTableGrid() {
    for (var r = 1; r <= TABLE_GRID_MAX; r++) {
      for (var c = 1; c <= TABLE_GRID_MAX; c++) {
        var cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.r = r;
        cell.dataset.c = c;
        els.tableGrid.appendChild(cell);
      }
    }
  })();

  els.tableGrid.addEventListener("mouseover", function (e) {
    var cell = e.target.closest(".cell");
    if (!cell) return;
    var r = Number(cell.dataset.r);
    var c = Number(cell.dataset.c);
    Array.prototype.forEach.call(els.tableGrid.children, function (el) {
      el.classList.toggle("hl", Number(el.dataset.r) <= r && Number(el.dataset.c) <= c);
    });
    els.tablePickerLabel.textContent = c + " × " + r + " table";
  });

  els.tableGrid.addEventListener("mouseleave", function () {
    Array.prototype.forEach.call(els.tableGrid.children, function (el) { el.classList.remove("hl"); });
    els.tablePickerLabel.textContent = "Insert table";
  });

  function buildMarkdownTable(cols, rows) {
    var headerCells = [];
    for (var c = 1; c <= cols; c++) headerCells.push("Header " + c);
    var lines = [
      "| " + headerCells.join(" | ") + " |",
      "| " + headerCells.map(function () { return "---"; }).join(" | ") + " |",
    ];
    for (var r = 0; r < rows; r++) {
      lines.push("|" + new Array(cols).fill("  |").join(""));
    }
    return lines.join("\n");
  }

  // GFM tables need a blank line before them to be recognized as a table
  // rather than a lazy continuation of the preceding paragraph.
  function insertTableAtCursor(cols, rows) {
    insertBlock(buildMarkdownTable(cols, rows));
    closeTablePicker();
  }

  els.tableGrid.addEventListener("click", function (e) {
    var cell = e.target.closest(".cell");
    if (!cell) return;
    insertTableAtCursor(Number(cell.dataset.c), Number(cell.dataset.r));
  });

  function openTablePicker() {
    els.tablePicker.hidden = false;
  }
  function closeTablePicker() {
    els.tablePicker.hidden = true;
  }
  els.btnTable.addEventListener("click", function () {
    if (els.tablePicker.hidden) openTablePicker(); else closeTablePicker();
  });
  document.addEventListener("click", function (e) {
    if (els.tablePicker.hidden) return;
    if (e.target === els.btnTable || els.btnTable.contains(e.target)) return;
    if (!els.tablePicker.contains(e.target)) closeTablePicker();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !els.tablePicker.hidden) closeTablePicker();
  });

  // --- modal ---

  function closeModal() {
    els.modalOverlay.hidden = true;
  }

  function openModal(title, defaultValue, onConfirm) {
    els.modalTitle.textContent = title;
    els.modalInput.value = defaultValue || "";
    els.modalError.hidden = true;
    els.modalOverlay.hidden = false;
    els.modalInput.focus();
    els.modalInput.select();
    els.modalConfirm.onclick = function () {
      var value = els.modalInput.value.trim();
      if (!value) {
        els.modalError.textContent = "Path is required.";
        els.modalError.hidden = false;
        return;
      }
      closeModal();
      onConfirm(value);
    };
  }

  els.modalCancel.addEventListener("click", closeModal);
  els.modalOverlay.addEventListener("click", function (e) {
    if (e.target === els.modalOverlay) closeModal();
  });
  els.modalInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") els.modalConfirm.click();
    else if (e.key === "Escape") closeModal();
  });

  // --- new / rename / delete ---

  els.btnNew.addEventListener("click", function () {
    if (!state.currentRepoId) return;
    if (!confirmDiscardIfDirty()) return;
    openModal("New file", "", function (path) {
      if (!path.toLowerCase().endsWith(".md") && !path.toLowerCase().endsWith(".markdown")) {
        path += ".md";
      }
      state.currentPath = path;
      state.isNewFile = true;
      cm.setValue("# " + path.split("/").pop().replace(/\.(md|markdown)$/i, "") + "\n\n");
      cm.clearHistory();
      setDirty(true);
      setCurrentPath(path);
      showEditor();
      schedulePreview();
      markActive(path);
      cm.setCursor(cm.lineCount(), 0);
      if (state.viewMode === "view") setViewMode("both");
      cm.focus();
    });
  });

  function promptRename(fromPath) {
    openModal("Rename " + fromPath, fromPath, function (toPath) {
      var message = window.prompt("Commit message:", "Rename " + fromPath + " to " + toPath);
      if (message === null) return;
      setStatus("Renaming…");
      api("/api/repos/" + encodeURIComponent(state.currentRepoId) + "/rename", {
        method: "POST",
        body: JSON.stringify({ from: fromPath, to: toPath, message: message }),
      })
        .then(function () {
          if (state.currentPath === fromPath) {
            state.currentPath = toPath;
            setCurrentPath(toPath);
          }
          setStatus("Renamed", "ok");
          loadTree();
        })
        .catch(function (err) {
          setStatus(err.message, "error");
        });
    });
  }

  function promptDelete(path) {
    if (!window.confirm("Delete " + path + "? This commits and pushes the removal.")) return;
    var message = window.prompt("Commit message:", "Delete " + path);
    if (message === null) return;
    setStatus("Deleting…");
    api(
      "/api/repos/" + encodeURIComponent(state.currentRepoId) + "/file?path=" +
        encodeURIComponent(path) + "&message=" + encodeURIComponent(message),
      { method: "DELETE" }
    )
      .then(function () {
        if (state.currentPath === path) closeFile();
        setStatus("Deleted", "ok");
        loadTree();
      })
      .catch(function (err) {
        setStatus(err.message, "error");
      });
  }

  window.addEventListener("beforeunload", function (e) {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // --- boot ---

  var savedMode = storageGet("gitmd.viewMode");
  setViewMode(savedMode === "edit" || savedMode === "view" ? savedMode : "both");
  setViewModesEnabled(false);
  if (storageGet("gitmd.sidebar") === "collapsed") els.app.classList.add("sidebar-collapsed");
  updateStatusBar();

  api("/api/repos")
    .then(function (repos) {
      showApp();
      populateRepos(repos);
    })
    .catch(function () {
      showLogin();
    });
})();
