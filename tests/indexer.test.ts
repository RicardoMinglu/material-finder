import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Indexer } from '../src/core/indexer.js';
import type { DocumentParser, FileKind, ParsedUnit, StoredUnit } from '../src/shared/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function page(text: string, ordinal = 0, needsOcr = false): ParsedUnit {
  return { key: `page-${ordinal + 1}`, ordinal, locator: { type: 'pdf', page: ordinal + 1 }, text, spans: [], needsOcr };
}

class FakeParser implements DocumentParser {
  extractionCalls: string[] = [];
  recognitionCalls: string[] = [];
  failures = new Set<string>();
  beforeExtractionHook?: (filePath: string) => Promise<void>;
  extractionHook?: (unit: ParsedUnit) => Promise<void>;
  recognitionHook?: (unit: ParsedUnit) => Promise<void>;
  disposed = false;
  async *extract(filePath: string, _kind: FileKind, _hash: string): AsyncGenerator<ParsedUnit> {
    this.extractionCalls.push(filePath);
    await this.beforeExtractionHook?.(filePath);
    const units = JSON.parse(await readFile(filePath, 'utf8')) as ParsedUnit[];
    for (const unit of units) {
      await this.extractionHook?.(unit);
      yield unit;
    }
  }
  async recognize(_filePath: string, unit: StoredUnit | ParsedUnit): Promise<ParsedUnit> {
    this.recognitionCalls.push(unit.key);
    await this.recognitionHook?.(unit);
    if (this.failures.has(unit.key)) throw new Error(`模拟识别失败 ${unit.key}`);
    return { ...unit, text: `${unit.text}\n扫描识别正文${unit.ordinal + 1}`, needsOcr: false };
  }
  async dispose() { this.disposed = true; }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'material-finder-indexer-'));
  const library = path.join(root, '资料');
  await mkdir(library);
  const parser = new FakeParser();
  const options = { dbPath: path.join(root, 'index.sqlite'), cacheDir: path.join(root, 'cache'), ocrDataDir: root, parser };
  const indexer = new Indexer(options);
  return {
    root, library, parser, options, indexer,
    async put(name: string, units: ParsedUnit[]) {
      const file = path.join(library, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(units));
      return file;
    },
    async cleanup() { await indexer.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('native text is searchable while OCR is pending; pause/resume preserves native content', { timeout: 10000 }, async () => {
  const env = await fixture();
  const entered = deferred(), release = deferred();
  env.parser.recognitionHook = async () => { entered.resolve(); await release.promise; };
  try {
    await env.put('混合试题.pdf', [page('已提取的原始题干'), page('扫描页页眉', 1, true)]);
    await env.indexer.selectFolder(env.library);
    await entered.promise;
    assert.equal(env.indexer.store.search({ text: '原始题干' }).total, 1);
    assert.equal(env.indexer.store.search({ text: '扫描页页眉' }).hits[0]!.ocrPending, true);
    assert.equal(env.indexer.store.search({ text: '扫描识别正文' }).total, 0);
    env.indexer.pause();
    release.resolve();
    await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().progress.phase, 'paused');
    assert.equal(env.indexer.store.getPendingOcr().length, 1);
    env.indexer.resume();
    await env.indexer.waitForIdle();
    assert.equal(env.parser.extractionCalls.length, 1);
    assert.equal(env.indexer.store.search({ text: '扫描识别正文2' }).total, 1);
    assert.equal(env.indexer.state().stats.ready, 1);
  } finally { release.resolve(); await env.cleanup(); }
});

test('duplicate content extracts once and incremental refresh removes stale source matches', { timeout: 10000 }, async () => {
  const env = await fixture();
  try {
    const original = await env.put('原件.pdf', [page('第一版重复题目')]);
    const copy = await env.put('复制件.pdf', [page('第一版重复题目')]);
    await writeFile(path.join(env.library, '教学视频.mp4'), 'ignored video bytes');
    await env.indexer.selectFolder(env.library);
    await env.indexer.waitForIdle();
    assert.equal(env.parser.extractionCalls.length, 1);
    assert.equal(env.indexer.state().stats.skipped, 1);
    assert.equal(env.indexer.store.search({ text: '重复题目' }).hits[0]!.sourceCount, 2);
    env.indexer.refresh();
    await env.indexer.waitForIdle();
    assert.equal(env.parser.extractionCalls.length, 1);
    await env.put('原件.pdf', [page('第二版重新修改后的新题目')]);
    await rm(copy);
    env.indexer.refresh();
    await env.indexer.waitForIdle();
    assert.equal(env.parser.extractionCalls.length, 2);
    assert.equal(env.indexer.store.search({ text: '重复题目' }).total, 0);
    assert.equal(env.indexer.store.search({ text: '修改后的新题目' }).total, 1);
    await rm(original);
    env.indexer.refresh();
    await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().stats.total, 0);
    assert.equal(env.indexer.store.search({ text: '新题目' }).total, 0);
  } finally { await env.cleanup(); }
});

test('an OCR failure does not block other pages and explicit retry recovers the document', { timeout: 10000 }, async () => {
  const env = await fixture();
  try {
    env.parser.failures.add('page-1');
    await env.put('扫描试题.pdf', [page('失败页原有页眉', 0, true), page('后续页原有页眉', 1, true)]);
    await env.indexer.selectFolder(env.library);
    await env.indexer.waitForIdle();
    assert.deepEqual(env.parser.recognitionCalls, ['page-1', 'page-2']);
    assert.equal(env.indexer.state().stats.errors, 1);
    assert.match(env.indexer.store.listDocuments()[0]!.error!, /1 个位置识别失败/);
    assert.equal(env.indexer.store.search({ text: '失败页原有页眉' }).total, 1);
    assert.equal(env.indexer.store.search({ text: '扫描识别正文2' }).total, 1);
    env.parser.failures.clear();
    await env.indexer.retry(env.indexer.store.listDocuments()[0]!.id);
    await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().stats.errors, 0);
    assert.equal(env.indexer.state().stats.ready, 1);
    assert.equal(env.indexer.store.search({ text: '扫描识别正文1' }).total, 1);
  } finally { await env.cleanup(); }
});

test('restart resumes unfinished OCR and does not repeat completed OCR pages', { timeout: 10000 }, async () => {
  const env = await fixture();
  const entered = deferred(), release = deferred();
  env.parser.recognitionHook = async unit => {
    if (unit.key === 'page-2') { entered.resolve(); await release.promise; }
  };
  let restarted: Indexer | undefined;
  let originalClosed = false;
  try {
    await env.put('断点试题.pdf', [page('页一', 0, true), page('页二', 1, true)]);
    await env.indexer.selectFolder(env.library);
    await entered.promise;
    assert.equal(env.indexer.store.search({ text: '扫描识别正文1' }).total, 1);
    const closing = env.indexer.close();
    release.resolve();
    await closing;
    originalClosed = true;
    const parser = new FakeParser();
    restarted = new Indexer({ ...env.options, parser });
    restarted.start();
    await restarted.waitForIdle();
    assert.equal(parser.extractionCalls.length, 0);
    assert.deepEqual(parser.recognitionCalls, ['page-2']);
    assert.equal(restarted.state().stats.ready, 1);
    assert.equal(restarted.store.search({ text: '扫描识别正文' }).total, 2);
  } finally {
    release.resolve();
    if (!originalClosed) await env.indexer.close();
    await restarted?.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('interrupted extraction retains completed units and recovers without duplicate rows', { timeout: 10000 }, async () => {
  const env = await fixture();
  const entered = deferred(), release = deferred();
  env.parser.extractionHook = async unit => {
    if (unit.key === 'page-2') { entered.resolve(); await release.promise; }
  };
  try {
    await env.put('部分提取.pdf', [page('第一页已经提取'), page('第二页继续提取', 1)]);
    await env.indexer.selectFolder(env.library);
    await entered.promise;
    env.indexer.pause();
    assert.equal(env.indexer.store.search({ text: '第一页已经提取' }).total, 1);
    release.resolve();
    await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().stats.queued, 1);
    env.indexer.resume();
    await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().stats.units, 2);
    assert.equal(env.indexer.store.search({ text: '已经提取' }).total, 1);
    assert.equal(env.indexer.store.search({ text: '继续提取' }).total, 1);
  } finally { release.resolve(); await env.cleanup(); }
});

test('paused state survives restart and folder switching clears the previous library', { timeout: 10000 }, async () => {
  const env = await fixture();
  let restarted: Indexer | undefined;
  let originalClosed = false;
  try {
    await env.put('原资料.pdf', [page('原资料内容')]);
    await env.indexer.selectFolder(env.library);
    await env.indexer.waitForIdle();
    env.indexer.pause();
    await env.indexer.close();
    originalClosed = true;
    const parser = new FakeParser();
    restarted = new Indexer({ ...env.options, parser });
    restarted.start();
    await restarted.waitForIdle();
    assert.equal(restarted.state().progress.phase, 'paused');
    assert.equal(parser.extractionCalls.length, 0);
    assert.equal(restarted.store.search({ text: '原资料内容' }).total, 1);
    const nextLibrary = path.join(env.root, '新资料');
    await mkdir(nextLibrary);
    await writeFile(path.join(nextLibrary, '新资料.pdf'), JSON.stringify([page('新的资料题目')]));
    await restarted.selectFolder(nextLibrary);
    await restarted.waitForIdle();
    assert.equal(restarted.store.search({ text: '原资料内容' }).total, 0);
    assert.equal(restarted.store.search({ text: '新的资料题目' }).total, 1);
    assert.equal(restarted.state().stats.total, 1);
  } finally {
    if (!originalClosed) await env.indexer.close();
    await restarted?.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('editing an original during extraction cannot corrupt an unchanged duplicate', { timeout: 10000 }, async () => {
  const env = await fixture();
  let changed = false;
  try {
    await env.put('a.pdf', [page('重复资料中的原始题目')]);
    await env.put('b.pdf', [page('重复资料中的原始题目')]);
    env.parser.beforeExtractionHook = async () => {
      if (changed) return;
      changed = true;
      await env.put('a.pdf', [page('在读取过程中被修改的新题目')]);
    };
    await env.indexer.selectFolder(env.library);
    await env.indexer.waitForIdle();
    env.indexer.refresh();
    await env.indexer.waitForIdle();
    assert.deepEqual(env.indexer.store.search({ text: '原始题目' }).hits.map(hit => hit.name), ['b.pdf']);
    assert.deepEqual(env.indexer.store.search({ text: '修改的新题目' }).hits.map(hit => hit.name), ['a.pdf']);
    assert.equal(env.indexer.state().stats.ready, 2);
  } finally { await env.cleanup(); }
});

test('restart repairs a final OCR commit whose document status update was interrupted', { timeout: 10000 }, async () => {
  for (const failed of [false, true]) {
    const env = await fixture();
    let restarted: Indexer | undefined;
    let originalClosed = false;
    try {
      await env.put('最后一页.pdf', [page('原生文字', 0, true)]);
      await env.indexer.selectFolder(env.library);
      await env.indexer.waitForIdle();
      const document = env.indexer.store.listDocuments()[0]!;
      const completed = env.indexer.store.getUnits(document.hash)[0]!;
      if (failed) env.indexer.store.upsertUnit(document.hash, {
        ...completed, needsOcr: false, ocrError: '最后一页识别失败',
      });
      // Emulate a crash after the durable final page write but before final status.
      env.indexer.store.setStatus(document.hash, 'indexing');
      await env.indexer.close();
      originalClosed = true;
      const parser = new FakeParser();
      restarted = new Indexer({ ...env.options, parser });
      restarted.start();
      await restarted.waitForIdle();
      assert.equal(restarted.store.listDocuments()[0]!.status, failed ? 'error' : 'ready');
      assert.equal(restarted.state().stats.indexing, 0);
      assert.equal(parser.extractionCalls.length, 0);
      assert.equal(parser.recognitionCalls.length, 0);
      if (failed) assert.match(restarted.store.listDocuments()[0]!.error!, /识别失败/);
    } finally {
      if (!originalClosed) await env.indexer.close();
      await restarted?.close();
      await rm(env.root, { recursive: true, force: true });
    }
  }
});

test('readding identical content after cache collection recreates the snapshot', async () => {
  const env = await fixture();
  try {
    const file = await env.put('归档.pdf', [page('归档原始资料')]);
    await env.indexer.selectFolder(env.library); await env.indexer.waitForIdle();
    assert.equal(env.indexer.store.search({text:'原始资料'}).total,1);
    await rm(file); env.indexer.refresh(); await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().stats.total,0);
    await env.put('归档.pdf', [page('归档原始资料')]);env.indexer.refresh();await env.indexer.waitForIdle();
    assert.equal(env.indexer.state().stats.errors,0);
    assert.equal(env.indexer.store.search({text:'原始资料'}).total,1);
  } finally { await env.cleanup(); }
});
