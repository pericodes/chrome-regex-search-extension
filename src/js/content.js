'use strict';

var HOST_ID = 'crs-find-host';
var SVG_NS = 'http://www.w3.org/2000/svg';
var DEFAULTS = {
  highlightColor: '#ffff00',
  selectedColor: '#ff9900',
  textColor: '#000000',
  maxResults: 500,
  instantResults: true,
  maxHistoryLength: 30
};
var SKIP = {
  script: 1, style: 1, noscript: 1, template: 1, canvas: 1, audio: 1, video: 1, select: 1
};
var BLOCK = {
  address: 1, article: 1, aside: 1, blockquote: 1, br: 1, caption: 1, dd: 1, details: 1,
  dialog: 1, div: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1,
  h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, li: 1, main: 1, nav: 1,
  ol: 1, p: 1, pre: 1, section: 1, table: 1, tbody: 1, thead: 1, tfoot: 1, tr: 1, ul: 1,
  td: 1, th: 1
};
var TEXT_INPUT = { text: 1, search: 1, url: 1, tel: 1, email: 1, number: 1 };
var IS_EXTENSION = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

var state = {
  open: false,
  ready: false,
  options: { matchCase: false, wholeWord: false, useRegex: false },
  settings: {
    highlightColor: DEFAULTS.highlightColor,
    selectedColor: DEFAULTS.selectedColor,
    textColor: DEFAULTS.textColor,
    maxResults: DEFAULTS.maxResults,
    instantResults: DEFAULTS.instantResults,
    maxHistoryLength: DEFAULTS.maxHistoryLength
  },
  history: [],
  matches: [],
  markElements: [],
  outlined: new Set(),
  selectedLocal: -1,
  total: 0,
  current: -1,
  requestId: 0,
  copyId: 0,
  searchedQuery: null,
  invalid: false,
  port: null,
  outbox: [],
  walkIframes: false,
  timer: 0,
  historyOpen: false,
  pendingToggle: false
};
var earlyMessages = [];
var ui = { toggles: {} };

function computedStyle(el, cache) {
  if (cache.has(el)) return cache.get(el);
  var style = null;
  try {
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (view && view.getComputedStyle) style = view.getComputedStyle(el);
  } catch (error) {}
  cache.set(el, style);
  return style;
}

function collectSegments(root) {
  var segments = [];
  var pendingBreak = false;
  var hasText = false;
  var cache = new WeakMap();

  function addBreak() {
    if (hasText) pendingBreak = true;
  }

  function addText(text, meta) {
    if (text == null) return;
    text = String(text);
    if (!text) return;
    if (pendingBreak) {
      segments.push({ text: '\n', synthetic: true });
      pendingBreak = false;
    }
    var segment = { text: text };
    var key;
    for (key in meta) {
      if (Object.prototype.hasOwnProperty.call(meta, key)) segment[key] = meta[key];
    }
    segments.push(segment);
    hasText = true;
  }

  function skipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || (el.hasAttribute && el.hasAttribute('hidden'))) return true;
    var style = computedStyle(el, cache);
    return !!(style && style.display === 'none');
  }

  function textParentHidden(el) {
    if (!el) return false;
    var style = computedStyle(el, cache);
    if (!style) return false;
    if (style.display === 'none') return true;
    return style.visibility === 'hidden' || style.visibility === 'collapse';
  }

  function walkSlot(node) {
    var assigned = node.assignedNodes ? node.assignedNodes({ flatten: true }) : [];
    var i;
    if (assigned && assigned.length) {
      for (i = 0; i < assigned.length; i++) walk(assigned[i]);
      return;
    }
    var kids = node.childNodes;
    for (i = 0; i < kids.length; i++) walk(kids[i]);
  }

  function walkFrame(node) {
    if (!state.walkIframes) return;
    try {
      var doc = node.contentDocument;
      if (doc && doc.body) {
        addBreak();
        walk(doc.body);
        addBreak();
      }
    } catch (error) {}
  }

  function addControl(node, tag) {
    if (tag === 'input') {
      var type = (node.getAttribute('type') || 'text').toLowerCase();
      if (!TEXT_INPUT[type]) return;
    }
    addText(node.value || '', { kind: 'input', element: node });
  }

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      if (textParentHidden(node.parentElement)) return;
      var parent = node.parentElement;
      var kind = parent && parent.namespaceURI === SVG_NS ? 'svg' : 'text';
      addText(node.data, { kind: kind, node: node, element: parent });
      return;
    }
    if (node.nodeType === 11) {
      var fragKids = node.childNodes;
      var f;
      for (f = 0; f < fragKids.length; f++) walk(fragKids[f]);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.id === HOST_ID) return;
    var tag = node.localName;
    if (!tag || SKIP[tag]) return;
    if (skipElement(node)) return;
    if (tag === 'input' || tag === 'textarea') {
      addControl(node, tag);
      return;
    }
    if (tag === 'iframe') {
      walkFrame(node);
      return;
    }
    if (tag === 'slot') {
      walkSlot(node);
      return;
    }
    var block = !!BLOCK[tag];
    if (node.shadowRoot) {
      if (block) addBreak();
      walk(node.shadowRoot);
      if (block) addBreak();
      return;
    }
    if (block) addBreak();
    var kids = node.childNodes;
    var k;
    for (k = 0; k < kids.length; k++) walk(kids[k]);
    if (block) addBreak();
  }

  if (root) walk(root);
  return segments;
}

function styleMark(mark, background, selected) {
  mark.style.setProperty('background-color', background, 'important');
  mark.style.setProperty('color', state.settings.textColor, 'important');
  mark.style.setProperty('box-shadow', selected ? '0 0 0 1px ' + state.settings.selectedColor : 'none', 'important');
}

function createMark(doc) {
  var mark = (doc || document).createElement('mark');
  mark.className = 'crs-hit';
  mark.style.setProperty('display', 'inline', 'important');
  mark.style.setProperty('padding', '0', 'important');
  mark.style.setProperty('margin', '0', 'important');
  mark.style.setProperty('border', 'none', 'important');
  mark.style.setProperty('border-radius', '2px', 'important');
  mark.style.setProperty('font', 'inherit', 'important');
  mark.style.setProperty('line-height', 'inherit', 'important');
  styleMark(mark, state.settings.highlightColor, false);
  return mark;
}

function wrapRange(textNode, start, end) {
  if (!textNode || !textNode.parentNode) return null;
  if (start < 0) start = 0;
  if (end > textNode.length) end = textNode.length;
  if (start >= end) return null;
  var target = textNode;
  if (start > 0) target = textNode.splitText(start);
  var len = end - start;
  if (len < target.length) target.splitText(len);
  var mark = createMark(textNode.ownerDocument);
  target.parentNode.insertBefore(mark, target);
  mark.appendChild(target);
  return mark;
}

function setOutline(el, color) {
  if (!el || el.nodeType !== 1) return;
  if (!el.hasAttribute('data-crs-outline')) {
    el.setAttribute('data-crs-outline', el.style.outline || '');
    el.setAttribute('data-crs-outline-offset', el.style.outlineOffset || '');
    state.outlined.add(el);
  }
  el.style.outline = '2px solid ' + color;
  el.style.outlineOffset = '1px';
}

function clearHighlights() {
  var parents = [];
  var seen = new WeakSet();
  var i;
  for (i = 0; i < state.markElements.length; i++) {
    var mark = state.markElements[i];
    var parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    if (!seen.has(parent)) {
      seen.add(parent);
      parents.push(parent);
    }
  }
  for (i = 0; i < parents.length; i++) {
    if (parents[i].normalize) parents[i].normalize();
  }
  state.markElements = [];
  state.outlined.forEach(function (el) {
    el.style.outline = el.getAttribute('data-crs-outline') || '';
    el.style.outlineOffset = el.getAttribute('data-crs-outline-offset') || '';
    el.removeAttribute('data-crs-outline');
    el.removeAttribute('data-crs-outline-offset');
  });
  state.outlined = new Set();
  state.matches = [];
  state.selectedLocal = -1;
}

function applyHighlights(matches, segments) {
  var groups = new Map();
  var m;
  for (m = 0; m < matches.length; m++) {
    var match = matches[m];
    match.marks = [];
    match.parts = [];
    var r;
    for (r = 0; r < match.ranges.length; r++) {
      var range = match.ranges[r];
      var seg = segments[range.segmentIndex];
      if (!seg || seg.synthetic) continue;
      if (seg.kind === 'text' && seg.node) {
        if (!groups.has(seg)) groups.set(seg, []);
        groups.get(seg).push({ start: range.start, end: range.end, match: match });
      } else if (seg.element) {
        match.parts.push({
          kind: seg.kind,
          element: seg.element,
          start: range.start,
          end: range.end
        });
        setOutline(seg.element, state.settings.highlightColor);
      }
    }
  }
  groups.forEach(function (ranges, seg) {
    ranges.sort(function (a, b) { return b.start - a.start; });
    var created = [];
    var i;
    for (i = 0; i < ranges.length; i++) {
      var mark = wrapRange(seg.node, ranges[i].start, ranges[i].end);
      if (mark) created.push({ mark: mark, match: ranges[i].match });
    }
    created.reverse();
    for (i = 0; i < created.length; i++) {
      created[i].match.marks.push(created[i].mark);
      state.markElements.push(created[i].mark);
    }
  });
}

function runSearch(query, options, maxResults) {
  clearHighlights();
  var opts = options || state.options;
  var limit = Number(maxResults != null ? maxResults : state.settings.maxResults);
  if (!limit || limit < 0) limit = DEFAULTS.maxResults;
  limit = Math.floor(limit);
  if (!query) return { count: 0, invalid: false };
  if (!globalThis.CrsSearch) return { count: 0, invalid: false };
  var built;
  try {
    built = globalThis.CrsSearch.buildPattern(query, opts);
  } catch (error) {
    return { count: 0, invalid: true };
  }
  if (!built.ok) return { count: 0, invalid: true };
  if (!built.regex || !document.body) return { count: 0, invalid: false };
  var segments = collectSegments(document.body);
  var found = globalThis.CrsSearch.findMatches(segments, built.regex, limit);
  applyHighlights(found, segments);
  state.matches = found;
  return { count: found.length, invalid: false };
}

function paintMatch(match, selected) {
  var background = selected ? state.settings.selectedColor : state.settings.highlightColor;
  var i;
  var marks = match.marks || [];
  for (i = 0; i < marks.length; i++) styleMark(marks[i], background, selected);
  var parts = match.parts || [];
  for (i = 0; i < parts.length; i++) setOutline(parts[i].element, background);
}

function clearSelection() {
  if (state.selectedLocal >= 0 && state.matches[state.selectedLocal]) {
    paintMatch(state.matches[state.selectedLocal], false);
  }
  state.selectedLocal = -1;
}

function selectLocal(index, flags) {
  clearSelection();
  var match = state.matches[index];
  if (!match) return;
  state.selectedLocal = index;
  paintMatch(match, true);
  flags = flags || {};
  var i;
  if (flags.focus && match.parts) {
    for (i = 0; i < match.parts.length; i++) {
      var part = match.parts[i];
      if (part.kind === 'input' && part.element) {
        try {
          part.element.focus({ preventScroll: true });
          part.element.setSelectionRange(part.start, part.end);
        } catch (error) {}
      }
    }
  }
  if (flags.scroll === false) return;
  var target = match.marks && match.marks[0];
  if (!target && match.parts && match.parts[0]) target = match.parts[0].element;
  if (target && target.scrollIntoView) {
    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (error) {
      try { target.scrollIntoView(); } catch (error2) {}
    }
  }
}

function updateToggleButtons() {
  var map = {
    matchCase: state.options.matchCase,
    wholeWord: state.options.wholeWord,
    useRegex: state.options.useRegex
  };
  var key;
  for (key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key) || !ui.toggles[key]) continue;
    ui.toggles[key].classList.toggle('active', !!map[key]);
    ui.toggles[key].setAttribute('aria-pressed', map[key] ? 'true' : 'false');
  }
}

function updateCountUI() {
  if (!ui.count || !ui.bar) return;
  ui.bar.classList.toggle('invalid', !!state.invalid);
  if (ui.input) ui.input.title = state.invalid ? 'Invalid expression' : '';
  if (state.invalid) {
    ui.count.textContent = '';
    ui.count.classList.remove('none');
    return;
  }
  var query = ui.input ? ui.input.value : '';
  if (!query) {
    ui.count.textContent = '';
    ui.count.classList.remove('none');
    return;
  }
  if (!state.total) {
    ui.count.textContent = '0 of 0';
    ui.count.classList.add('none');
    return;
  }
  var current = state.current >= 0 ? state.current + 1 : 1;
  ui.count.textContent = current + ' of ' + state.total;
  ui.count.classList.remove('none');
}

function post(msg) {
  if (!IS_EXTENSION) return;
  if (state.port) {
    try { state.port.postMessage(msg); } catch (error) {}
  } else {
    state.outbox.push(msg);
  }
}

function performSearch(query) {
  state.searchedQuery = query;
  var requestId = ++state.requestId;
  var result = runSearch(query, state.options, state.settings.maxResults);
  state.invalid = !!result.invalid;
  if (!IS_EXTENSION) {
    state.total = state.invalid ? 0 : result.count;
    state.current = state.total ? 0 : -1;
    if (state.total) selectLocal(0, { scroll: true, focus: false });
    updateCountUI();
    return;
  }
  if (state.invalid) {
    state.total = 0;
    state.current = -1;
  } else {
    state.total = result.count;
    state.current = result.count ? 0 : -1;
    if (result.count) selectLocal(0, { scroll: true, focus: false });
  }
  post({
    type: 'search',
    requestId: requestId,
    query: state.invalid ? '' : query,
    localCount: state.invalid ? 0 : result.count,
    options: {
      matchCase: !!state.options.matchCase,
      wholeWord: !!state.options.wholeWord,
      useRegex: !!state.options.useRegex
    },
    maxResults: state.settings.maxResults
  });
  updateCountUI();
}

function scheduleSearch() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(function () {
    state.timer = 0;
    if (ui.input) performSearch(ui.input.value);
  }, 60);
}

function navigate(delta) {
  if (ui.input && ui.input.value) addToHistory(ui.input.value);
  if (!IS_EXTENSION) {
    if (!state.total) return;
    state.current = (state.current + delta + state.total) % state.total;
    selectLocal(state.current, { scroll: true, focus: true });
    updateCountUI();
    return;
  }
  post({ type: 'navigate', delta: delta });
}

function onEnter(shift) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = 0;
  }
  var query = ui.input ? ui.input.value : '';
  if (query !== state.searchedQuery) {
    performSearch(query);
    if (query && !state.invalid) addToHistory(query);
    return;
  }
  if (state.invalid) return;
  navigate(shift ? -1 : 1);
}

function addToHistory(query) {
  if (!query) return;
  var max = state.settings.maxHistoryLength || DEFAULTS.maxHistoryLength;
  var next = [];
  var i;
  for (i = 0; i < state.history.length; i++) {
    if (state.history[i] !== query) next.push(state.history[i]);
  }
  next.push(query);
  if (next.length > max) next = next.slice(next.length - max);
  state.history = next;
  if (IS_EXTENSION) chrome.storage.local.set({ searchHistory: state.history });
  if (state.historyOpen) renderHistory();
}

function fallbackCopy(text) {
  var area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.focus();
  area.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (error) {}
  area.remove();
  if (ui.input) ui.input.focus();
  return ok;
}

function flashCopy(ok, empty) {
  if (!ui.copy) return;
  var previous = 'Copy matches';
  ui.copy.title = ok ? (empty ? 'Nothing to copy' : 'Copied') : 'Could not copy';
  setTimeout(function () { if (ui.copy) ui.copy.title = previous; }, 1200);
}

function writeClipboard(text, silent) {
  var value = text || '';
  var finish = function (ok) {
    if (!silent) flashCopy(ok, !value);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(function () {
      finish(true);
    }, function () {
      finish(fallbackCopy(value));
    });
    return;
  }
  finish(fallbackCopy(value));
}

function localMatchText() {
  return state.matches.map(function (match) { return match.text; }).join('\n');
}

function copyMatches() {
  var local = localMatchText();
  if (!IS_EXTENSION) {
    writeClipboard(local);
    return;
  }
  state.pendingCopy = ++state.copyId;
  writeClipboard(local);
  post({ type: 'copy', requestId: state.pendingCopy });
}

function renderHistory() {
  if (!ui.historyPanel) return;
  ui.historyPanel.textContent = '';
  if (!state.history.length) {
    var empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Search history is empty.';
    ui.historyPanel.appendChild(empty);
    return;
  }
  var i;
  for (i = state.history.length - 1; i >= 0; i--) {
    (function (text) {
      var row = document.createElement('div');
      row.className = 'history-row';
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '×';
      del.title = 'Quitar';
      del.addEventListener('click', function (event) {
        event.stopPropagation();
        state.history = state.history.filter(function (item) { return item !== text; });
        if (IS_EXTENSION) chrome.storage.local.set({ searchHistory: state.history });
        renderHistory();
      });
      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'link';
      link.textContent = text;
      link.title = text;
      link.addEventListener('click', function () {
        ui.input.value = text;
        hideHistory();
        performSearch(text);
        ui.input.focus();
      });
      row.appendChild(del);
      row.appendChild(link);
      ui.historyPanel.appendChild(row);
    })(state.history[i]);
  }
  var clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'history-clear';
  clear.textContent = 'Clear history';
  clear.addEventListener('click', function () {
    state.history = [];
    if (IS_EXTENSION) chrome.storage.local.set({ searchHistory: state.history });
    renderHistory();
  });
  ui.historyPanel.appendChild(clear);
}

function showHistory() {
  state.historyOpen = true;
  ui.historyPanel.classList.add('open');
  renderHistory();
}

function hideHistory() {
  state.historyOpen = false;
  if (ui.historyPanel) ui.historyPanel.classList.remove('open');
}

function pinHost(open) {
  if (!ui.host) return;
  ui.host.style.setProperty('display', open ? 'block' : 'none', 'important');
}

function openBar() {
  if (window !== window.top || !ui.host) return;
  state.open = true;
  pinHost(true);
  updateToggleButtons();
  updateCountUI();
  var focus = function () {
    if (!ui.input) return;
    ui.input.focus();
    ui.input.select();
  };
  focus();
  setTimeout(focus, 0);
  if (ui.input && ui.input.value) performSearch(ui.input.value);
}

function closeBar() {
  state.open = false;
  hideHistory();
  pinHost(false);
  clearHighlights();
  state.total = 0;
  state.current = -1;
  state.invalid = false;
  state.searchedQuery = null;
  updateCountUI();
  if (IS_EXTENSION) post({ type: 'closeSearch' });
}

function toggleBar() {
  if (state.open) closeBar();
  else openBar();
}

function handlePortMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'summary') {
    if (msg.requestId !== state.requestId) return;
    if (!state.invalid) {
      state.total = msg.total || 0;
      state.current = typeof msg.current === 'number' ? msg.current : -1;
    } else {
      state.total = 0;
      state.current = -1;
    }
    updateCountUI();
  } else if (msg.type === 'select') {
    selectLocal(msg.localIndex, { scroll: msg.scroll !== false, focus: !!msg.focus });
  } else if (msg.type === 'clearSelection') {
    clearSelection();
  } else if (msg.type === 'clearAll') {
    clearHighlights();
    state.total = 0;
    state.current = -1;
    updateCountUI();
  } else if (msg.type === 'searchLocal') {
    var result = runSearch(msg.query || '', msg.options || state.options, msg.maxResults);
    post({
      type: 'searchResult',
      requestId: msg.requestId,
      count: result.invalid ? 0 : result.count
    });
  } else if (msg.type === 'getTexts') {
    post({
      type: 'texts',
      requestId: msg.requestId,
      texts: state.matches.map(function (match) { return match.text; })
    });
  } else if (msg.type === 'clipboard') {
    var local = localMatchText();
    if ((msg.text || '') !== local) writeClipboard(msg.text || '', true);
  }
}

function onPortMessage(msg) {
  if (!state.ready) {
    earlyMessages.push(msg);
    return;
  }
  handlePortMessage(msg);
}

function connectPort() {
  if (!IS_EXTENSION) return;
  var port;
  try {
    port = chrome.runtime.connect({ name: 'crs' });
  } catch (error) {
    setTimeout(connectPort, 500);
    return;
  }
  port.onMessage.addListener(onPortMessage);
  state.port = port;
  port.onDisconnect.addListener(function () {
    if (state.port === port) state.port = null;
    state.outbox = [];
    setTimeout(function () {
      if (!state.port) connectPort();
    }, 200);
  });
  var queued = state.outbox.splice(0, state.outbox.length);
  var research = window === window.top && state.open && state.searchedQuery;
  if (research) performSearch(state.searchedQuery);
  else queued.forEach(function (msg) {
    try { port.postMessage(msg); } catch (error) {}
  });
}

function loadSettings(done) {
  function apply(stored) {
    stored = stored || {};
    state.settings.highlightColor = stored.highlightColor || DEFAULTS.highlightColor;
    state.settings.selectedColor = stored.selectedColor || DEFAULTS.selectedColor;
    state.settings.textColor = stored.textColor || DEFAULTS.textColor;
    state.settings.maxResults = Number(stored.maxResults) || DEFAULTS.maxResults;
    state.settings.instantResults = stored.instantResults != null ? !!stored.instantResults : DEFAULTS.instantResults;
    state.settings.maxHistoryLength = Number(stored.maxHistoryLength) || DEFAULTS.maxHistoryLength;
    var matchCase = false;
    if (typeof stored.matchCase === 'boolean') matchCase = stored.matchCase;
    else if (typeof stored.caseInsensitive === 'boolean') matchCase = !stored.caseInsensitive;
    state.options = {
      matchCase: matchCase,
      wholeWord: !!stored.wholeWord,
      useRegex: !!stored.useRegex
    };
    state.history = Array.isArray(stored.searchHistory) ? stored.searchHistory.slice() : [];
    updateToggleButtons();
    if (done) done();
  }
  if (!IS_EXTENSION) {
    apply(null);
    return;
  }
  chrome.storage.local.get(null, function (stored) {
    apply(stored || {});
  });
}

function watchStorage() {
  if (!IS_EXTENSION || !chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes) return;
    if (changes.highlightColor) state.settings.highlightColor = changes.highlightColor.newValue || DEFAULTS.highlightColor;
    if (changes.selectedColor) state.settings.selectedColor = changes.selectedColor.newValue || DEFAULTS.selectedColor;
    if (changes.textColor) state.settings.textColor = changes.textColor.newValue || DEFAULTS.textColor;
    if (changes.maxResults) state.settings.maxResults = Number(changes.maxResults.newValue) || DEFAULTS.maxResults;
    if (changes.instantResults) state.settings.instantResults = !!changes.instantResults.newValue;
    if (changes.maxHistoryLength) state.settings.maxHistoryLength = Number(changes.maxHistoryLength.newValue) || DEFAULTS.maxHistoryLength;
    if (changes.searchHistory && Array.isArray(changes.searchHistory.newValue)) {
      state.history = changes.searchHistory.newValue.slice();
      if (state.historyOpen) renderHistory();
    }
    if (changes.matchCase && typeof changes.matchCase.newValue === 'boolean') state.options.matchCase = changes.matchCase.newValue;
    if (changes.wholeWord && typeof changes.wholeWord.newValue === 'boolean') state.options.wholeWord = changes.wholeWord.newValue;
    if (changes.useRegex && typeof changes.useRegex.newValue === 'boolean') state.options.useRegex = changes.useRegex.newValue;
    updateToggleButtons();
  });
}

function icon(path) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';
}

function createBar() {
  var existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();
  var host = document.createElement('div');
  host.id = HOST_ID;
  ui.host = host;
  pinHost(false);
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '0', 'important');
  host.style.setProperty('right', '0', 'important');
  host.style.setProperty('left', 'auto', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('margin', '0', 'important');
  host.style.setProperty('padding', '0', 'important');
  host.style.setProperty('border', '0', 'important');
  host.style.setProperty('background', 'transparent', 'important');
  host.style.setProperty('width', 'auto', 'important');
  host.style.setProperty('height', 'auto', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  (document.documentElement || document.body).appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '' +
    '<style>' +
    '.bar{all:initial;position:fixed;top:8px;right:8px;z-index:2147483647;display:flex;align-items:center;gap:2px;box-sizing:border-box;max-width:calc(100vw - 16px);padding:4px 6px 4px 12px;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 1px 2px rgba(60,64,67,.3),0 2px 6px rgba(60,64,67,.15);font-family:"Segoe UI",Roboto,Arial,sans-serif;font-size:13px;line-height:1.4;color:#202124;pointer-events:auto;direction:ltr}' +
    '.bar.invalid{box-shadow:0 0 0 1px #d93025,0 2px 6px rgba(0,0,0,.2)}' +
    '.field{display:flex;align-items:center;flex:1 1 auto;min-width:0}' +
    'input{flex:1 1 auto;width:180px;min-width:48px;max-width:280px;border:0;outline:0;background:transparent;color:inherit;font:inherit;padding:6px 0;margin:0}' +
    '.count{color:#5f6368;font-size:12px;white-space:nowrap;margin:0 6px 0 8px;user-select:none}' +
    '.count.none{color:#d93025}' +
    'button{box-sizing:border-box;border:0;background:transparent;color:#5f6368;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none}' +
    'button:hover{background:#f1f3f4}' +
    'button.active{background:#d3e3fd;color:#174ea6}' +
    'button:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}' +
    'button.toggle{min-width:28px;height:28px;padding:0 5px;border-radius:4px;font-family:Consolas,"Courier New",monospace;font-size:12px;font-weight:700}' +
    'button.icon{width:28px;height:28px;border-radius:50%}' +
    'button.icon svg{width:16px;height:16px;display:block}' +
    '.ab{border-bottom:1px solid currentColor;line-height:1;pointer-events:none}' +
    '.sep{width:1px;height:18px;background:#dadce0;margin:0 4px;flex:none}' +
    '.history{display:none;position:absolute;top:100%;right:0;margin-top:4px;min-width:240px;max-width:360px;max-height:240px;overflow:auto;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);padding:4px 0;color:#202124}' +
    '.history.open{display:block}' +
    '.history-row{display:flex;align-items:center;gap:4px;padding:2px 8px}' +
    '.history-row .link{all:unset;cursor:pointer;color:#1a73e8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font:13px "Segoe UI",Roboto,Arial,sans-serif;padding:4px 0}' +
    '.history-row .del{all:unset;cursor:pointer;color:#c5221f;width:18px;text-align:center;font-size:14px}' +
    '.history-empty{padding:8px 12px;color:#5f6368;font-style:italic}' +
    '.history-clear{all:unset;display:block;box-sizing:border-box;width:100%;text-align:left;cursor:pointer;padding:8px 12px;color:#202124;font:13px "Segoe UI",Roboto,Arial,sans-serif}' +
    '.history-clear:hover,.history-row .link:hover{background:#f1f3f4}' +
    '</style>' +
    '<div class="bar" id="bar" role="search">' +
      '<div class="field"><input id="q" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search"><span id="count" class="count" aria-live="polite"></span></div>' +
      '<button type="button" class="toggle" id="matchCase" title="Match case" aria-pressed="false">Aa</button>' +
      '<button type="button" class="toggle" id="wholeWord" title="Whole word" aria-pressed="false"><span class="ab">ab</span></button>' +
      '<button type="button" class="toggle" id="useRegex" title="Use regular expression" aria-pressed="false">.*</button>' +
      '<span class="sep"></span>' +
      '<button type="button" class="icon" id="copy" title="Copy matches" aria-label="Copy matches">' + icon('<rect x="8" y="8" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" fill="none" stroke="currentColor" stroke-width="2"/>') + '</button>' +
      '<button type="button" class="icon" id="history" title="Search history" aria-label="Search history">' + icon('<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') + '</button>' +
      '<button type="button" class="icon" id="prev" title="Previous (Shift+Enter)" aria-label="Previous">' + icon('<path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>') + '</button>' +
      '<button type="button" class="icon" id="next" title="Next (Enter)" aria-label="Next">' + icon('<path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>') + '</button>' +
      '<button type="button" class="icon" id="close" title="Close (Esc)" aria-label="Close">' + icon('<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') + '</button>' +
      '<div class="history" id="historyPanel"></div>' +
    '</div>';
  ui.bar = shadow.getElementById('bar');
  ui.input = shadow.getElementById('q');
  ui.count = shadow.getElementById('count');
  ui.copy = shadow.getElementById('copy');
  ui.historyPanel = shadow.getElementById('historyPanel');
  ui.toggles = {};
  ['matchCase', 'wholeWord', 'useRegex'].forEach(function (key) {
    var button = shadow.getElementById(key);
    ui.toggles[key] = button;
    button.addEventListener('click', function () {
      state.options[key] = !state.options[key];
      updateToggleButtons();
      if (IS_EXTENSION) {
        var patch = {};
        patch[key] = state.options[key];
        chrome.storage.local.set(patch);
      }
      if ((ui.input && ui.input.value) || state.total) performSearch(ui.input.value);
    });
  });
  shadow.getElementById('prev').addEventListener('click', function () { navigate(-1); });
  shadow.getElementById('next').addEventListener('click', function () { navigate(1); });
  shadow.getElementById('close').addEventListener('click', function () { closeBar(); });
  ui.copy.addEventListener('click', copyMatches);
  shadow.getElementById('history').addEventListener('click', function () {
    if (state.historyOpen) hideHistory();
    else showHistory();
  });
  ui.input.addEventListener('input', function () {
    if (state.settings.instantResults) scheduleSearch();
  });
  ui.input.addEventListener('keydown', function (event) {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onEnter(event.shiftKey);
    }
  });
  shadow.addEventListener('mousedown', function (event) {
    if (event.target && event.target.closest && event.target.closest('button')) event.preventDefault();
  });
  document.addEventListener('mousedown', function (event) {
    if (!state.historyOpen || !ui.host || !ui.host.isConnected) return;
    var path = event.composedPath ? event.composedPath() : [];
    if (path.indexOf(ui.host) !== -1) return;
    hideHistory();
  }, true);
  window.addEventListener('keydown', function (event) {
    if (!state.open || !ui.host || !ui.host.isConnected) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (state.historyOpen) hideHistory();
    else closeBar();
  }, true);
  updateToggleButtons();
}

function flushEarly() {
  var queued = earlyMessages.splice(0, earlyMessages.length);
  var i;
  for (i = 0; i < queued.length; i++) handlePortMessage(queued[i]);
}

function install() {
  if (globalThis.__crsInstalled) return;
  globalThis.__crsInstalled = true;
  if (!IS_EXTENSION && window === window.top) state.walkIframes = true;
  if (window === window.top) createBar();
  if (IS_EXTENSION) {
    connectPort();
    watchStorage();
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.message !== 'toggle' || window !== window.top) return;
      if (!state.ready) state.pendingToggle = !state.pendingToggle;
      else toggleBar();
      sendResponse({ ok: true });
    });
  }
  loadSettings(function () {
    state.ready = true;
    flushEarly();
    if (state.pendingToggle) {
      state.pendingToggle = false;
      toggleBar();
    }
    if (!IS_EXTENSION && window === window.top) {
      var openDemo = function () {
        if (state.open) return;
        openBar();
      };
      if (document.readyState === 'complete') openDemo();
      else window.addEventListener('load', openDemo);
      document.addEventListener('load', function (event) {
        if (!state.walkIframes || !state.open || !state.searchedQuery) return;
        if (event.target && event.target.tagName === 'IFRAME') performSearch(state.searchedQuery);
      }, true);
    }
  });
}

install();
