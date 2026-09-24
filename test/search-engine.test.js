'use strict';

var assert = require('assert');
var engine = require('../src/js/search-engine.js');
var buildPattern = engine.buildPattern;
var findMatches = engine.findMatches;

var passed = 0;

function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

function search(query, options, segments, maxResults) {
  var built = buildPattern(query, options);
  if (!built.ok) return built;
  built.matches = findMatches(segments, built.regex, maxResults == null ? 50 : maxResults);
  return built;
}

var literal = { matchCase: false, wholeWord: false, useRegex: false };

var fileLiteral = search('file.txt', literal, [{ text: 'fileXtxt' }]);
check(fileLiteral.ok && fileLiteral.matches.length === 0, 'literal file.txt no coincide con fileXtxt');
check(search('file.txt', literal, [{ text: 'ver file.txt aqui' }]).matches.length === 1, 'literal file.txt coincide con el punto');

var asRegex = search('file.txt', { matchCase: false, wholeWord: false, useRegex: true }, [{ text: 'fileXtxt' }]);
check(asRegex.ok && asRegex.matches.length === 1, 'regex file.txt sí usa el punto como comodín');

var split = search('opp', literal, [{ text: 'op' }, { text: 'p' }]);
check(split.matches.length === 1, 'op + p coincide con opp');
check(split.matches[0].ranges.length === 2, 'la coincidencia partida devuelve dos rangos');
check(split.matches[0].ranges[0].segmentIndex === 0 && split.matches[0].ranges[0].start === 0 && split.matches[0].ranges[0].end === 2, 'primer fragmento completo');
check(split.matches[0].ranges[1].segmentIndex === 1 && split.matches[0].ranges[1].start === 0 && split.matches[0].ranges[1].end === 1, 'segundo fragmento completo');

check(search('foobar', literal, [{ text: 'foo' }, { text: 'bar' }]).matches.length === 1, 'nodos en línea se concatenan');
check(search('foobar', literal, [{ text: 'foo' }, { text: '\n', synthetic: true }, { text: 'bar' }]).matches.length === 0, 'un salto de bloque no une foobar');

var wrapped = search('foo bar', literal, [{ text: 'foo' }, { text: '\n', synthetic: true }, { text: 'bar' }]);
check(wrapped.matches.length === 1, 'foo bar coincide a través de un salto de línea');
check(wrapped.matches[0].ranges.length === 3, 'el salto sintético queda dentro del rango');

var word = { matchCase: false, wholeWord: true, useRegex: false };
var wordHits = search('opp', word, [{ text: 'opportunity OPP' }]);
check(wordHits.matches.length === 1 && wordHits.matches[0].text === 'OPP', 'palabra completa no entra en opportunity');

var splitWord = search('opp', word, [{ text: 'op' }, { text: 'p' }, { text: ' opportunity' }]);
check(splitWord.matches.length === 1, 'palabra completa partida en dos nodos');
check(splitWord.matches[0].ranges.length === 2, 'no incluye opportunity');

check(search('opp', { matchCase: true, wholeWord: false, useRegex: false }, [{ text: 'Opp' }]).matches.length === 0, 'Aa activo distingue mayúsculas');
check(search('opp', literal, [{ text: 'Opp' }]).matches.length === 1, 'sin Aa no distingue mayúsculas');

var invalidThrew = false;
var invalid;
try {
  invalid = buildPattern('(', { matchCase: false, wholeWord: false, useRegex: true });
} catch (error) {
  invalidThrew = true;
}
check(!invalidThrew && invalid && invalid.ok === false && !invalid.regex, 'regex inválida no lanza');
check(search('(', literal, [{ text: 'a(b' }]).matches.length === 1, 'un paréntesis literal sí se encuentra');

check(search('', literal, [{ text: 'abc' }]).matches.length === 0, 'consulta vacía no busca');
check(findMatches([{ text: 'aaa' }], buildPattern('a', literal).regex, 2).length === 2, 'respeta el máximo de resultados');

var middle = search('opp', literal, [{ text: 'xxoppyy' }]);
check(middle.matches.length === 1 && middle.matches[0].ranges[0].start === 2 && middle.matches[0].ranges[0].end === 5, 'rango dentro del fragmento');

console.log(passed + ' pruebas ok');
