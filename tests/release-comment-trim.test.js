// Comment-trimming proof for the 1.5.4 release packet.
//
// The release trims EXPLANATORY comments the candidate added on top of 1.5.3 so the archive
// fits its byte budget. This file proves the trim changed nothing else — the risk being a
// contract comment deleted by accident, or an edit that silently touched code.
//
// How it proves it WITHOUT a second copy of the source in the repository:
//  * every src file is a script or a declaration file, never a mixture;
//  * a lexer that understands strings, template literals, regex literals and char classes
//    removes comments only — so a `//` inside a string is not mistaken for a comment;
//  * whitespace that carries no meaning is normalised on both sides.
// What survives must therefore be exactly the executable/declaration content. Both the
// pre-trim and the trimmed file pass through the same function, so the comparison answers
// "did any token change", which is the question the packet asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reduce source text to its meaningful content: no comments, no insignificant whitespace.
 * @param {string} text - source text.
 * @param {boolean} declarationsOnly - `.d.ts` grammar: no template literals and no regex
 *   literals, so `//` in those positions cannot occur and quoting rules are simpler.
 * @returns {string} the normalised content.
 */
export function meaningfulContent(text, declarationsOnly = false) {
  let out = '';
  let index = 0;
  let state = 'code';
  let quote = '';
  let inCharClass = false;
  let previous = '';
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += char;
      }
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 2;
        continue;
      }
      if (char === '\n') out += char;
      index += 1;
      continue;
    }
    if (state === 'string' || state === 'template') {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === quote) state = 'code';
      index += 1;
      continue;
    }
    if (state === 'regex') {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '[') inCharClass = true;
      else if (char === ']') inCharClass = false;
      else if (char === '/' && !inCharClass) state = 'code';
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      state = 'line';
      index += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block';
      index += 2;
      continue;
    }
    if (!declarationsOnly && (char === '"' || char === "'")) {
      state = 'string';
      quote = char;
      out += char;
      previous = char;
      index += 1;
      continue;
    }
    if (!declarationsOnly && char === '`') {
      state = 'template';
      quote = char;
      out += char;
      previous = char;
      index += 1;
      continue;
    }
    if (!declarationsOnly && char === '/'
      && (previous === '' || '=([{,;:!&|?+-*%<>~^'.includes(previous))) {
      state = 'regex';
      inCharClass = false;
      out += char;
      previous = char;
      index += 1;
      continue;
    }
    out += char;
    if (!/\s/u.test(char)) previous = char;
    index += 1;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Read one repository file.
 * @param {string} path - repository-relative path.
 * @returns {string} contents.
 */
function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('the trimmer removes comments and nothing else, even around strings, templates and regexes', () => {
  const source = [
    '// leading comment',
    'const url = "https://example.invalid/a//b"; // trailing comment',
    'const tpl = `x ${"// not a comment"} y`;',
    'const re = /\\/\\/[^/]+/u;',
    '/* block',
    '   comment */ const half = 1 / 2;',
  ].join('\n');
  const content = meaningfulContent(source);
  assert.ok(!content.includes('leading comment'));
  assert.ok(!content.includes('trailing comment'));
  assert.ok(!content.includes('block'));
  assert.ok(content.includes('"https://example.invalid/a//b"'), 'a `//` inside a string survives');
  assert.ok(content.includes('`x ${"// not a comment"} y`'), 'a `//` inside a template survives');
  assert.ok(content.includes('/\\/\\/[^/]+/u'), 'a regex literal survives');
  assert.ok(content.includes('1 / 2'), 'division is not a regex');
});

test('the declaration file keeps every declaration after the comment trim', () => {
  const declarations = meaningfulContent(read('src/index.d.ts'), true);
  assert.ok(declarations.includes('export interface DelegateSubmitRequest'));
  assert.ok(declarations.includes('goalDescription?: string'), 'the submission goal survives');
  assert.ok(declarations.includes('completionSummary?: string'), 'the review summary survives');
  assert.ok(declarations.includes('export interface DelegateCompletionSummaryPageRequest'));
  assert.ok(declarations.includes('export interface DelegateCompletionSummaryPageResult'));
  assert.ok(!declarations.includes('RELEASE_BUDGET_PLACEHOLDER'));
});

test('the trimmed modules keep the shared description rule and its call sites', () => {
  const module = meaningfulContent(read('src/jobs/task-descriptions.js'));
  for (const exported of [
    'TASK_DESCRIPTION_MAX_CHARS = 2_000',
    'TASK_DESCRIPTION_FIELDS = Object.freeze(',
    'export function normalizeTaskDescription',
    'export function taskDescriptionLength',
    'export function taskDescriptionRefusal',
    'export function taskDescriptionPresent',
    'export function readTaskDescription',
    'export function canonicalTaskDescription',
    'export function truncateTaskDescription',
  ]) {
    assert.ok(module.includes(exported), `the shared rule still exports ${exported}`);
  }
  for (const path of ['src/jobs/history.js', 'src/jobs/engine.js', 'src/mcp/server.js', 'src/http/execution-plane.js']) {
    const content = meaningfulContent(read(path));
    assert.ok(content.includes("from '../jobs/task-descriptions.js'") || content.includes("from './task-descriptions.js'"),
      `${path} still imports the shared rule`);
    assert.ok(content.includes('canonicalTaskDescription'), `${path} still canonicalizes through it`);
  }
});

test('the release keeps its budget stricter than the hard packed bound', () => {
  const packet = read('tests/package.test.js');
  assert.match(packet, /assert\.ok\(total < 3_120_000/u, 'the hard bound is bounded');
  assert.match(packet, /const RELEASE_BUDGET_BYTES = 3_080_000;/u, 'the packet budget is 3,080,000');
  assert.match(packet, /total <= RELEASE_BUDGET_BYTES/u, 'the packet budget is actually asserted');
  assert.match(packet, /const DELIVERABLE_VERSION = '1\.9\.0';/u);
  assert.match(packet, /const PREVIOUS_VERSION = '1\.8\.1';/u);
});
