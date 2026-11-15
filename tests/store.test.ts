import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { matchText, normalizeText, prepareQuery, rankText } from '../src/core/search.js';
import type { ParsedUnit } from '../src/shared/types.js';

function source(store: Store, name: string, hash = name) {
  return store.upsertSource({
    path: `/library/${name}`, relativePath: name, name: path.basename(name),
    kind: 'pdf', size: 100, mtime: 1, hash,
  });
}

function unit(text: string, key = 'page-1'): ParsedUnit {
  return { key, ordinal: 1, locator: { type: 'pdf', page: 1 }, text, spans: [], needsOcr: false };
}

test('Chinese short keywords and trigrams both search literal content', () => {
  const store = new Store(':memory:');
  try {
    source(store, '真题.pdf');
    store.upsertUnit('真题.pdf', unit('中国石化招聘考试：责任感与管理能力。'));
    for (const text of ['石', '石化', '中国石化', '责任感']) {
      assert.equal(store.search({ text }).total, 1, text);
    }
    assert.equal(store.search({ text: '中国石油' }).total, 0);
  } finally { store.close(); }
});

test('multi-keyword AND ranks exact phrase then nearest occurrences', () => {
  const store = new Store(':memory:');
  try {
    for (const [name, text] of [
      ['far.pdf', '管理' + '的'.repeat(80) + '能力'],
      ['near.pdf', '管理与能力'], ['exact.pdf', '管理能力'], ['only.pdf', '管理知识'],
    ]) { source(store, name!); store.upsertUnit(name!, unit(text!)); }
    const results = store.search({ text: '管理 能力' });
    assert.equal(results.total, 3);
    assert.deepEqual(results.hits.map(hit => hit.name), ['exact.pdf', 'near.pdf', 'far.pdf']);
    assert.equal(results.hits[0]!.exact, true);
    assert.equal(results.hits[1]!.exact, false);
  } finally { store.close(); }
});

test('layout and fullwidth normalization preserve original UTF-16 highlight positions', () => {
  const store = new Store(':memory:');
  try {
    source(store, '数字.pdf');
    const text = '😀前言：招聘\n考试 ＡＢＣ１２３ 后文';
    const start = text.indexOf('招聘'), end = text.indexOf(' 后文');
    const stored = store.upsertUnit('数字.pdf', {
      ...unit(text), spans: [{ start, end, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 } }],
    });
    const result = store.search({ text: '招聘考试abc123' });
    assert.equal(result.total, 1);
    const hit = result.hits[0]!;
    assert.equal(hit.snippet.slice(hit.highlights[0]!.start, hit.highlights[0]!.end), '招聘\n考试 ＡＢＣ１２３');
    assert.deepEqual(store.getMatch(stored, '招聘考试abc123').highlights, [{ start, end }]);
    assert.deepEqual(hit.rects, [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }]);
    const expanded = normalizeText('ﬃ😀');
    assert.equal(expanded.text, 'ffi😀');
    assert.deepEqual(expanded.starts, [0, 0, 0, 1, 1]);
    assert.deepEqual(expanded.ends, [1, 1, 1, 3, 3]);
  } finally { store.close(); }
});

test('SQL, FTS, wildcard punctuation and folder filters are treated literally', () => {
  const store = new Store(':memory:');
  try {
    source(store, 'a_b/quoted.pdf');
    store.upsertUnit('a_b/quoted.pdf', unit('literal_% 100% a"b quoted'));
    source(store, 'acb/other.pdf');
    store.upsertUnit('acb/other.pdf', unit('literalXX 1000 axb quoted'));
    assert.equal(store.search({ text: '%' }).total, 1);
    assert.equal(store.search({ text: '_' }).total, 1);
    assert.equal(store.search({ text: 'literal_%' }).total, 1);
    assert.equal(store.search({ text: 'a"b' }).total, 1);
    assert.equal(store.search({ text: "' OR 1=1 --" }).total, 0);
    assert.equal(store.search({ text: 'quoted', folder: 'a_b' }).total, 1);
    assert.equal(store.search({ text: 'quoted', kind: 'word' }).total, 0);
    assert.equal(store.search({ text: '  \n  ' }).total, 0);
  } finally { store.close(); }
});

test('duplicate copies share units, updates and deletions do not leave stale FTS hits', () => {
  const store = new Store(':memory:');
  try {
    const first = source(store, 'one.pdf', 'same');
    const second = source(store, 'copy.pdf', 'same');
    const original = store.upsertUnit('same', unit('旧的原始内容'));
    store.setStatus('same', 'ready');
    assert.equal(store.getDocument(second.id)!.status, 'ready');
    assert.equal(store.search({ text: '原始内容' }).total, 1);
    assert.equal(store.search({ text: '原始内容' }).hits[0]!.sourceCount, 2);
    store.upsertUnit('same', unit('新的替换内容'));
    assert.equal(store.getUnits('same')[0]!.id, original.id);
    assert.equal(store.search({ text: '原始内容' }).total, 0);
    assert.equal(store.search({ text: '替换内容' }).total, 1);
    store.removeSource(first.id);
    assert.equal(store.search({ text: '替换内容' }).hits[0]!.documentId, second.id);
    assert.equal(store.search({ text: '替换内容' }).hits[0]!.sourceCount, 1);
    source(store, 'copy.pdf', 'modified');
    assert.equal(store.search({ text: '替换内容' }).total, 0);
    assert.equal(store.getUnits('same').length, 0);
    store.upsertUnit('modified', unit('文件更新后的内容'));
    store.removeSource(second.id);
    assert.equal(store.search({ text: '更新后的内容' }).total, 0);
    assert.equal(store.getState().stats.units, 0);
  } finally { store.close(); }
});

test('persistent extraction, OCR queue and pause state survive restart and root switch', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'material-finder-store-'));
  const database = path.join(directory, 'index.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(database);
    store.setLibrary(directory);
    source(store, 'scanned.pdf', 'scan');
    source(store, 'scanned-copy.pdf', 'scan');
    store.upsertUnit('scan', { ...unit('可先搜索的题头'), needsOcr: true });
    store.upsertUnit('scan', { ...unit('', 'page-2'), ordinal: 2, needsOcr: true, ocrError: '识别失败' });
    store.markContentExtracted('scan');
    store.setMeta('paused', true);
    store.setSkipped(107);
    store.close();
    store = new Store(database);
    assert.equal(store.isContentExtracted('scan'), true);
    assert.equal(store.getPendingOcr().length, 1);
    assert.equal(store.getState().stats.ocrPending, 2);
    assert.equal(store.getState().progress.phase, 'paused');
    assert.equal(store.getState().stats.skipped, 107);
    store.setLibrary(directory);
    assert.equal(store.search({ text: '搜索的题头' }).total, 1);
    store.setLibrary(path.join(directory, 'new-library'));
    assert.equal(store.search({ text: '搜索的题头' }).total, 0);
    assert.equal(store.getState().stats.total, 0);
    assert.equal(store.getState().stats.units, 0);
    assert.equal(store.getState().progress.phase, 'idle');
    assert.equal(store.getLibrary()!.missing, true);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('snippets retain valid highlight offsets after truncation and paging', () => {
  const store = new Store(':memory:');
  try {
    source(store, '长文.pdf');
    for (let i = 1; i <= 3; i++) {
      store.upsertUnit('长文.pdf', { ...unit('前'.repeat(280) + '中石化试题' + '后'.repeat(280), `page-${i}`), ordinal: i });
    }
    const response = store.search({ text: '中石化', offset: 1, limit: 1 });
    assert.equal(response.total, 3);
    assert.equal(response.hits.length, 1);
    const hit = response.hits[0]!;
    assert.equal(hit.snippet.startsWith('…'), true);
    assert.equal(hit.snippet.endsWith('…'), true);
    assert.equal(hit.snippet.slice(hit.highlights[0]!.start, hit.highlights[0]!.end), '中石化');
  } finally { store.close(); }
});

test('lightweight ranking preserves proximity for overlapping, repeated and reversed terms', () => {
  const cases: Array<[string, string, { exact: boolean; proximity: number } | null]> = [
    ['管理与能力', '管理 能力', { exact: false, proximity: 5 }],
    ['管理\n能力', '管理 能力', { exact: true, proximity: 4 }],
    ['管理与能力', '管理能力', null],
    ['abc', 'abc bc', { exact: false, proximity: 3 }],
    ['aba', 'a a', { exact: false, proximity: 1 }],
    ['aaa', 'a a', { exact: true, proximity: 2 }],
    ['abZZZZbcabc', 'abc bc', { exact: false, proximity: 3 }],
    ['能力' + '的'.repeat(20) + '管理与能力', '管理 能力', { exact: false, proximity: 5 }],
    ['ＡＢＣ \n 管理', '管理 abc', { exact: false, proximity: 5 }],
  ];
  for (const [text, query, expected] of cases) {
    const normalized = normalizeText(text), prepared = prepareQuery(query);
    assert.deepEqual(rankText(normalized.text, prepared), expected, `${text}: ${query}`);
    const full = matchText(normalized, prepared);
    assert.deepEqual(full ? { exact: full.exact, proximity: full.proximity } : null, expected);
  }
});

test('large candidate pagination preserves source filters, copy counts and highlights', context => {
  const store = new Store(':memory:');
  try {
    source(store, '章节/试题.pdf', 'large');
    source(store, '副本/试题.pdf', 'large');
    const text = '背景说明'.repeat(200) + '管理 能力' + '上下文'.repeat(100);
    for (let i = 0; i < 180; i++) store.upsertUnit('large', {
      ...unit(text, `page-${i}`), ordinal: i, locator: { type: 'pdf', page: i + 1 },
      spans: [{ start: 800, end: 805, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
    });
    const result = store.search({ text: '管理 能力', folder: '副本', offset: 60, limit: 30 });
    assert.equal(result.total, 180);
    assert.equal(result.hits.length, 30);
    assert.deepEqual(result.hits[0]!.locator, { type: 'pdf', page: 61 });
    assert.deepEqual(result.hits.at(-1)!.locator, { type: 'pdf', page: 90 });
    for (const hit of result.hits) {
      assert.equal(hit.relativePath, '副本/试题.pdf');
      assert.equal(hit.sourceCount, 2);
      assert.equal(hit.exact, true);
      assert.equal(hit.snippet.slice(hit.highlights[0]!.start, hit.highlights[0]!.end), '管理 能力');
      assert.equal(hit.rects.length, 1);
    }
    context.diagnostic(`180 candidates, 30 materialized hits: ${result.elapsedMs.toFixed(1)} ms`);
  } finally { store.close(); }
});

test('read-only legacy databases search without migration and writable reopen adds the covering index', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'material-finder-index-migration-'));
  const database = path.join(directory, 'library.sqlite');
  let store: Store | undefined;
  let raw: DatabaseSync | undefined;
  try {
    store = new Store(database);
    source(store, '试题.pdf');
    store.upsertUnit('试题.pdf', unit('中文管理能力 ＡＢＣ１２３'));
    const expected = store.search({ text: '管理' }).hits;
    store.close(); store = undefined;
    raw = new DatabaseSync(database);
    raw.exec('DROP INDEX units_search_text');
    raw.close(); raw = undefined;
    store = new Store(database, { readOnly: true });
    assert.deepEqual(store.search({ text: '管理' }).hits, expected);
    assert.equal(store.search({ text: '管理能力' }).total, 1);
    assert.throws(() => store!.setMeta('paused', true), /readonly/i);
    store.close(); store = undefined;
    raw = new DatabaseSync(database, { readOnly: true });
    assert.equal(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name='units_search_text'").get(), undefined);
    raw.close(); raw = undefined;
    store = new Store(database);
    assert.deepEqual(store.search({ text: '管理' }).hits, expected);
    store.close(); store = undefined;
    raw = new DatabaseSync(database, { readOnly: true });
    assert.ok(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name='units_search_text'").get());
    raw.close(); raw = undefined;
    store = new Store(database, { readOnly: true });
    assert.deepEqual(store.search({ text: '管理' }).hits, expected);
  } finally {
    store?.close(); raw?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
