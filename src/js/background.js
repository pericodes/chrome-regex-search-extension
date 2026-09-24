'use strict';

var portsByTab = new Map();
var sessionByTab = new Map();
var copyJobs = new Map();

chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });

function framesOf(tabId) {
  return portsByTab.get(tabId) || new Map();
}

function orderedFrameIds(tabId) {
  return Array.from(framesOf(tabId).keys()).sort(function (a, b) { return a - b; });
}

function setBadge(tabId, total) {
  var text = '';
  if (total > 999) text = '999+';
  else if (total > 0) text = String(total);
  chrome.action.setBadgeText({ tabId: tabId, text: text });
}

function publish(tabId, scroll, focus) {
  var session = sessionByTab.get(tabId);
  if (!session) return;
  var frames = framesOf(tabId);
  var owner = null;
  var localIndex = -1;
  if (session.current >= 0) {
    var remaining = session.current;
    var i;
    for (i = 0; i < session.order.length; i++) {
      var entry = session.order[i];
      if (remaining < entry.count) {
        owner = entry.frameId;
        localIndex = remaining;
        break;
      }
      remaining -= entry.count;
    }
  }
  frames.forEach(function (port, id) {
    try {
      if (id === owner) {
        port.postMessage({ type: 'select', localIndex: localIndex, scroll: !!scroll, focus: !!focus });
      } else {
        port.postMessage({ type: 'clearSelection' });
      }
    } catch (error) {}
  });
  var top = frames.get(0);
  if (top) {
    try {
      top.postMessage({
        type: 'summary',
        requestId: session.requestId,
        total: session.total,
        current: session.current
      });
    } catch (error) {}
  }
  setBadge(tabId, session.total);
}

function finishSearch(tabId, resetIndex) {
  var session = sessionByTab.get(tabId);
  if (!session || session.finished) return;
  session.finished = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = 0;
  }
  var previousCurrent = session.current;
  var ids = orderedFrameIds(tabId);
  var seen = {};
  var ordered = [];
  var i;
  for (i = 0; i < ids.length; i++) {
    seen[ids[i]] = true;
    ordered.push(ids[i]);
  }
  session.counts.forEach(function (count, id) {
    if (!seen[id]) ordered.push(id);
  });
  ordered.sort(function (a, b) { return a - b; });
  session.order = ordered.map(function (id) {
    return { frameId: id, count: session.counts.get(id) || 0 };
  });
  session.total = session.order.reduce(function (sum, item) { return sum + item.count; }, 0);
  if (resetIndex || previousCurrent == null || previousCurrent < 0 || session.total === 0) {
    session.current = session.total > 0 ? 0 : -1;
  } else if (previousCurrent >= session.total) {
    session.current = session.total - 1;
  } else {
    session.current = previousCurrent;
  }
  var shouldScroll = !!resetIndex || (previousCurrent < 0 && session.total > 0);
  publish(tabId, shouldScroll, false);
}

function beginSearch(tabId, frameId, msg) {
  var previous = sessionByTab.get(tabId);
  if (previous && previous.timer) clearTimeout(previous.timer);
  var session = {
    requestId: msg.requestId,
    query: msg.query || '',
    options: msg.options || {},
    maxResults: msg.maxResults,
    counts: new Map(),
    pending: new Set(),
    current: -1,
    finished: false,
    resetIndex: true,
    timer: 0,
    order: [],
    total: 0
  };
  session.counts.set(frameId, msg.localCount || 0);
  sessionByTab.set(tabId, session);
  var frames = framesOf(tabId);
  if (!session.query) {
    frames.forEach(function (port, id) {
      if (id === frameId) return;
      try { port.postMessage({ type: 'clearAll' }); } catch (error) {}
    });
    session.finished = true;
    session.order = [{ frameId: frameId, count: 0 }];
    session.total = 0;
    session.current = -1;
    publish(tabId, false, false);
    return;
  }
  frames.forEach(function (port, id) {
    if (id === frameId) return;
    session.pending.add(id);
    try {
      port.postMessage({
        type: 'searchLocal',
        requestId: session.requestId,
        query: session.query,
        options: session.options,
        maxResults: session.maxResults
      });
    } catch (error) {
      session.pending.delete(id);
    }
  });
  if (session.pending.size === 0) finishSearch(tabId, true);
  else session.timer = setTimeout(function () { finishSearch(tabId, true); }, 500);
}

function noteResult(tabId, frameId, msg) {
  var session = sessionByTab.get(tabId);
  if (!session || session.requestId !== msg.requestId) return;
  session.counts.set(frameId, msg.count || 0);
  session.pending.delete(frameId);
  if (session.finished) {
    session.finished = false;
    finishSearch(tabId, false);
    return;
  }
  if (session.pending.size === 0) finishSearch(tabId, session.resetIndex !== false);
}

function move(tabId, delta) {
  var session = sessionByTab.get(tabId);
  if (!session || !session.finished || !session.total) return;
  var step = delta || 1;
  session.current = (session.current + step + session.total) % session.total;
  publish(tabId, true, true);
}

function closeAll(tabId, fromFrameId) {
  var session = sessionByTab.get(tabId);
  if (session && session.timer) clearTimeout(session.timer);
  sessionByTab.delete(tabId);
  framesOf(tabId).forEach(function (port, id) {
    if (id === fromFrameId) return;
    try { port.postMessage({ type: 'clearAll' }); } catch (error) {}
  });
  setBadge(tabId, 0);
}

function requestCopy(tabId, requestId) {
  var frames = framesOf(tabId);
  var job = {
    requestId: requestId,
    tabId: tabId,
    pending: new Set(frames.keys()),
    texts: new Map(),
    done: false,
    timer: 0
  };
  copyJobs.set(requestId, job);
  frames.forEach(function (port) {
    try { port.postMessage({ type: 'getTexts', requestId: requestId }); } catch (error) {}
  });
  if (job.pending.size === 0) finishCopy(requestId);
  else job.timer = setTimeout(function () { finishCopy(requestId); }, 400);
}

function noteTexts(tabId, frameId, msg) {
  var job = copyJobs.get(msg.requestId);
  if (!job || job.tabId !== tabId) return;
  job.texts.set(frameId, msg.texts || []);
  job.pending.delete(frameId);
  if (job.pending.size === 0) finishCopy(msg.requestId);
}

function finishCopy(requestId) {
  var job = copyJobs.get(requestId);
  if (!job || job.done) return;
  job.done = true;
  if (job.timer) clearTimeout(job.timer);
  var session = sessionByTab.get(job.tabId);
  var ids = [];
  var seen = {};
  var order = session && session.order ? session.order : [];
  var i;
  for (i = 0; i < order.length; i++) {
    ids.push(order[i].frameId);
    seen[order[i].frameId] = true;
  }
  job.texts.forEach(function (list, id) {
    if (!seen[id]) ids.push(id);
  });
  var parts = [];
  for (i = 0; i < ids.length; i++) {
    var list = job.texts.get(ids[i]) || [];
    if (list.length) parts.push(list.join('\n'));
  }
  var top = framesOf(job.tabId).get(0);
  if (top) {
    try { top.postMessage({ type: 'clipboard', text: parts.join('\n') }); } catch (error) {}
  }
  copyJobs.delete(requestId);
}

function askFrameToSearch(tabId, frameId, port) {
  var session = sessionByTab.get(tabId);
  if (frameId === 0) return;
  if (!session || !session.query) {
    try { port.postMessage({ type: 'clearAll' }); } catch (error) {}
    return;
  }
  var keepPosition = !!session.finished;
  session.finished = false;
  session.resetIndex = !keepPosition;
  session.pending.add(frameId);
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(function () {
    finishSearch(tabId, session.resetIndex !== false);
  }, 500);
  try {
    port.postMessage({
      type: 'searchLocal',
      requestId: session.requestId,
      query: session.query,
      options: session.options,
      maxResults: session.maxResults
    });
  } catch (error) {
    session.pending.delete(frameId);
  }
}

chrome.runtime.onConnect.addListener(function (port) {
  if (!port || port.name !== 'crs' || !port.sender || !port.sender.tab) return;
  var tabId = port.sender.tab.id;
  var frameId = port.sender.frameId;
  if (tabId == null || frameId == null) return;
  if (!portsByTab.has(tabId)) portsByTab.set(tabId, new Map());
  var frames = portsByTab.get(tabId);
  frames.set(frameId, port);
  port.onDisconnect.addListener(function () {
    var current = portsByTab.get(tabId);
    if (!current || current.get(frameId) !== port) return;
    current.delete(frameId);
    if (!current.size) portsByTab.delete(tabId);
    var session = sessionByTab.get(tabId);
    if (!session) return;
    session.pending.delete(frameId);
    var hadCount = session.counts.delete(frameId);
    if (session.finished && hadCount) {
      session.finished = false;
      finishSearch(tabId, false);
    } else if (!session.finished && session.pending.size === 0) {
      finishSearch(tabId, session.resetIndex !== false);
    }
  });
  port.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'search') beginSearch(tabId, frameId, msg);
    else if (msg.type === 'searchResult') noteResult(tabId, frameId, msg);
    else if (msg.type === 'navigate') move(tabId, msg.delta);
    else if (msg.type === 'closeSearch') closeAll(tabId, frameId);
    else if (msg.type === 'copy') requestCopy(tabId, msg.requestId);
    else if (msg.type === 'texts') noteTexts(tabId, frameId, msg);
  });
  askFrameToSearch(tabId, frameId, port);
});

function toggle(tabId) {
  chrome.tabs.sendMessage(tabId, { message: 'toggle' }, { frameId: 0 }).catch(function () {
    return chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ['js/search-engine.js', 'js/content.js']
    }).then(function () {
      return chrome.tabs.sendMessage(tabId, { message: 'toggle' }, { frameId: 0 });
    });
  }).catch(function () {});
}

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  var url = tab.url || '';
  if (url && !/^(https?:|file:)/i.test(url)) return;
  toggle(tab.id);
});
