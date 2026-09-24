(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrsSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function literalSource(query) {
    return escapeRegExp(query).replace(/\s+/g, '\\s+');
  }

  function buildPattern(query, options) {
    var opts = options || {};
    var text = query == null ? '' : String(query);
    if (!text) {
      return { ok: true, regex: null };
    }
    var source = opts.useRegex ? text : literalSource(text);
    if (opts.wholeWord) {
      source = '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])';
    }
    var flags = opts.matchCase ? 'gu' : 'giu';
    try {
      return { ok: true, regex: new RegExp(source, flags) };
    } catch (error) {
      return { ok: false, regex: null, error: String(error && error.message || error) };
    }
  }

  function rangesFor(map, start, end) {
    var ranges = [];
    var i;
    for (i = 0; i < map.length; i++) {
      var entry = map[i];
      if (entry.end <= start) continue;
      if (entry.start >= end) break;
      var sliceStart = Math.max(0, start - entry.start);
      var sliceEnd = Math.min(entry.end, end) - entry.start;
      if (sliceStart < sliceEnd) {
        ranges.push({
          segmentIndex: entry.index,
          start: sliceStart,
          end: sliceEnd
        });
      }
    }
    return ranges;
  }

  function findMatches(segments, regex, maxResults) {
    if (!regex || !segments || !segments.length) return [];
    var limit = maxResults == null ? Infinity : Math.max(0, maxResults | 0);
    if (!limit) return [];

    var haystack = '';
    var map = [];
    var i;
    for (i = 0; i < segments.length; i++) {
      var text = segments[i] && segments[i].text ? String(segments[i].text) : '';
      if (!text) continue;
      var start = haystack.length;
      haystack += text;
      map.push({ start: start, end: start + text.length, index: i });
    }
    if (!haystack) return [];

    var flags = regex.flags.indexOf('g') === -1 ? regex.flags + 'g' : regex.flags;
    var re = new RegExp(regex.source, flags);
    var matches = [];
    var guard = 0;
    while (matches.length < limit && guard < haystack.length + 1) {
      guard += 1;
      var found = re.exec(haystack);
      if (!found) break;
      if (!found[0].length) {
        var next = found.index + 1;
        if (next > haystack.length) break;
        re.lastIndex = next;
        continue;
      }
      matches.push({
        text: found[0],
        start: found.index,
        end: found.index + found[0].length,
        ranges: rangesFor(map, found.index, found.index + found[0].length)
      });
      if (re.lastIndex <= found.index) break;
    }
    return matches;
  }

  return {
    escapeRegExp: escapeRegExp,
    buildPattern: buildPattern,
    findMatches: findMatches
  };
});
