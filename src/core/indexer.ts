import { collectCache } from './cache';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { opendir, stat, realpath, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { Store } from './store';
import { createDocumentParser } from './parser';
import type { AppState, DocumentParser, FileKind, IndexProgress, SourceDocument } from '../shared/types';

export interface IndexerOptions {
  dbPath: string; cacheDir: string; ocrDataDir: string;
  onState?: (state: AppState) => void;
  parser?: DocumentParser;
  ocrConcurrency?: number;
}
class SourceChangedError extends Error {}
const kinds: Record<string, FileKind> = {
  '.pdf': 'pdf', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.bmp': 'image', '.tif': 'image', '.tiff': 'image', '.doc': 'word', '.docx': 'word', '.rtf': 'word',
};
async function fingerprint(file: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** One writer; all checkpoints are persisted before moving to the next unit. */
export class Indexer {
  readonly store: Store;
  private parser: DocumentParser;
  private ocrParsers: DocumentParser[];
  private snapshots = new Map<string, Promise<string>>();
  private paused = false;
  private stopping = false;
  private scanRequested = false;
  private running: Promise<void> | null = null;
  private progress: IndexProgress = { phase: 'idle' };
  private lastEmit = 0;
  constructor(private options: IndexerOptions) {
    this.store = new Store(options.dbPath);
    this.paused = this.store.getMeta<boolean>('paused') === true;
    const makeParser = () => createDocumentParser({
      cacheDir: options.cacheDir, ocrDataDir: options.ocrDataDir,
      shouldStop: () => this.paused || this.stopping,
      onProgress: fraction => { this.progress.fraction = fraction; this.emit(false); },
    });
    this.parser = options.parser ?? makeParser();
    const concurrency = options.parser ? 1 : Math.max(1, Math.min(3, options.ocrConcurrency ?? Math.floor(availableParallelism() / 3)));
    this.ocrParsers = [this.parser, ...Array.from({ length: concurrency - 1 }, makeParser)];
  }
  private emit(force = true) {
    if (!force && Date.now() - this.lastEmit < 450) return;
    this.lastEmit = Date.now();
    this.options.onState?.(this.store.getState(this.progress));
  }
  state() { return this.store.getState(this.progress); }
  /** Parse a verified immutable copy so concurrent edits never poison shared hashes. */
  private snapshot(doc: SourceDocument): Promise<string> {
    let promise = this.snapshots.get(doc.hash);
    if (!promise) {
      promise = (async () => {
        const directory = path.join(this.options.cacheDir, 'sources');
        await mkdir(directory, { recursive: true });
        const target = path.join(directory, doc.hash + path.extname(doc.name).toLowerCase());
        if (await stat(target).then(s => s.isFile()).catch(() => false)) return target;
        const candidates = [doc, ...this.store.listDocuments().filter(d => d.hash === doc.hash && d.id !== doc.id)];
        let lastError: unknown;
        for (const candidate of candidates) {
          const temporary = `${target}.${process.pid}.tmp`;
          try {
            await copyFile(candidate.path, temporary, constants.COPYFILE_FICLONE);
            if (await fingerprint(temporary) !== doc.hash) { lastError = new SourceChangedError('资料在读取时发生变化，正在重新读取。'); continue; }
            await rename(temporary, target);
            return target;
          } catch (error) { lastError = error; }
          finally { await rm(temporary, { force: true }).catch(() => {}); }
        }
        if (lastError instanceof SourceChangedError || (lastError as NodeJS.ErrnoException)?.code === 'ENOENT') { this.scanRequested = true; throw new SourceChangedError('资料已更新，正在重新读取。'); }
        throw lastError ?? new Error('资料无法读取。');
      })().catch(error => { this.snapshots.delete(doc.hash); throw error; });
      this.snapshots.set(doc.hash, promise);
    }
    return promise;
  }
  private finishContent(hash: string) {
    if (!this.store.isContentExtracted(hash)) return;
    const units = this.store.getUnits(hash);
    if (units.some(u => u.needsOcr)) return;
    const failed = units.filter(u => u.ocrError);
    this.store.setStatus(hash, failed.length ? 'error' : 'ready', failed.length ? `${failed.length} 个位置识别失败：${failed[0].ocrError}` : undefined);
  }
  start() { if (this.store.getLibrary()) { this.scanRequested = true; this.kick(); } else this.emit(); }
  async selectFolder(root: string) {
    const resolved = await realpath(root);
    if (!(await stat(resolved)).isDirectory()) throw new Error('请选择资料文件夹。');
    this.stopping = true;
    await this.running;
    this.stopping = false;
    this.paused = false;
    this.store.setLibrary(resolved);
    this.store.setMeta('paused', false);
    this.scanRequested = true;
    this.kick();
  }
  refresh() { this.scanRequested = true; this.kick(); }
  pause() { this.paused = true; this.store.setMeta('paused', true); this.progress = { ...this.progress, phase: 'paused' }; this.emit(); }
  resume() { this.paused = false; this.store.setMeta('paused', false); this.kick(); }
  async retry(id?: number) {
    this.stopping = true;
    await this.running;
    this.stopping = false;
    const docs = id === undefined ? this.store.listDocuments().filter(d => d.status === 'error') : [this.store.getDocument(id)].filter(Boolean);
    for (const doc of docs) {
      if (!doc) continue;
      this.store.clearContent(doc.hash);
      this.store.setStatus(doc.hash, 'queued');
    }
    this.paused = false;
    this.store.setMeta('paused', false);
    this.scanRequested = true;
    this.kick();
  }
  private kick() {
    if (this.paused || this.stopping) { this.progress = { phase: 'paused' }; this.emit(); return; }
    if (this.running) return;
    this.running = this.run().catch(error => {
      this.progress = { phase: 'idle', message: errorText(error) };
      this.emit();
    }).finally(() => {
      this.running = null;
      if (this.scanRequested && !this.paused && !this.stopping) this.kick();
    });
  }
  private async scan() {
    const library = this.store.getLibrary();
    if (!library) return;
    this.scanRequested = false;
    this.progress = { phase: 'scanning' };
    this.emit();
    try { if (!(await stat(library.rootPath)).isDirectory()) throw new Error('目录不存在'); }
    catch { this.store.setMeta('libraryMissing', true); throw new Error('找不到资料文件夹，请重新选择文件夹。已有搜索索引仍保留。'); }
    this.store.setMeta('libraryMissing', false);
    const old = new Map(this.store.listDocuments().map(d => [d.path, d]));
    const seen = new Set<string>();
    let skipped = 0;
    const walk = async (dir: string): Promise<void> => {
      for await (const entry of await opendir(dir)) {
        if (this.paused || this.stopping) return;
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        const file = path.join(dir, entry.name);
        if (file === path.dirname(this.options.dbPath) || file === this.options.cacheDir || file === this.options.dbPath) continue;
        if (entry.isDirectory()) {
          try { await walk(file); } catch {
            // Preserve previously indexed descendants when a subtree is temporarily unreadable.
            for (const previous of old.keys()) if (previous.startsWith(file + path.sep)) seen.add(previous);
            this.progress.message = `无法读取子文件夹：${entry.name}，请检查权限后刷新。`;
          }
          continue;
        }
        if (!entry.isFile()) { skipped++; continue; }
        const kind = kinds[path.extname(entry.name).toLowerCase()];
        if (!kind) { skipped++; continue; }
        seen.add(file);
        this.progress.currentFile = entry.name;
        const prev = old.get(file);
        const base = { path: file, relativePath: path.relative(library.rootPath, file).split(path.sep).join('/'), name: entry.name, kind };
        try {
          const info = await stat(file);
          if (prev && !prev.hash.startsWith('unreadable:') && prev.size === info.size && prev.mtime === info.mtimeMs) continue;
          const hash = await fingerprint(file);
          this.store.upsertSource({ ...base, size: info.size, mtime: info.mtimeMs, hash });
        } catch (error) {
          const hash = `unreadable:${createHash('sha256').update(file).digest('hex')}`;
          this.store.upsertSource({ ...base, size: prev?.size ?? 0, mtime: prev?.mtime ?? 0, hash });
          this.store.setStatus(hash, 'error', `无法读取文件：${errorText(error)}`);
        }
        this.emit(false);
      }
    };
    await walk(library.rootPath);
    if (this.paused || this.stopping) { this.scanRequested = true; return; }
    for (const [file, doc] of old) if (!seen.has(file)) this.store.removeSource(doc.id);
    this.store.setSkipped(skipped);
    this.emit();
  }
  private async run() {
    if (!this.store.getLibrary()) return;
    await mkdir(this.options.cacheDir, { recursive: true });
    while (!this.paused && !this.stopping) {
      if (this.scanRequested) await this.scan();
      if (this.paused || this.stopping) break;
      const documents = this.store.listDocuments();
      const processed = new Set<string>();
      // Finish inexpensive native extraction for every file before expensive OCR.
      for (const doc of documents) {
        if (this.paused || this.stopping) break;
        if (processed.has(doc.hash) || doc.status === 'error' || this.store.isContentExtracted(doc.hash)) continue;
        processed.add(doc.hash);
        this.progress = { phase: 'extracting', currentFile: doc.name };
        this.store.setStatus(doc.hash, 'indexing'); this.emit();
        try {
          const snapshotPath = await this.snapshot(doc);
          for await (const unit of this.parser.extract(snapshotPath, doc.kind, doc.hash)) {
            if (this.paused || this.stopping) break;
            this.store.upsertUnit(doc.hash, unit);
            this.progress.currentUnit = unit.locator.type === 'pdf' ? `第 ${unit.locator.page} 页` : `第 ${unit.ordinal + 1} 段`;
            this.emit(false);
          }
          if (this.paused || this.stopping) { this.store.setStatus(doc.hash, 'queued'); break; }
          this.store.markContentExtracted(doc.hash);
          this.store.setStatus(doc.hash, this.store.getUnits(doc.hash).some(u => u.needsOcr) ? 'indexing' : 'ready');
        } catch (error) {
          if (error instanceof SourceChangedError) { this.store.setStatus(doc.hash, 'queued'); continue; }
          if (this.paused || this.stopping) { this.store.setStatus(doc.hash, 'queued'); break; }
          this.store.setStatus(doc.hash, 'error', errorText(error));
        }
        this.emit();
      }
      const pending = this.store.getPendingOcr();
      let cursor = 0;
      await Promise.all(this.ocrParsers.map(async parser => {
        while (cursor < pending.length && !this.paused && !this.stopping && !this.scanRequested) {
          const { document: doc, unit } = pending[cursor++];
          this.progress = { phase: 'ocr', currentFile: doc.name, currentUnit: unit.locator.type === 'pdf' ? `第 ${unit.locator.page} 页` : unit.locator.type === 'word' && unit.locator.imageIndex ? `内嵌图片 ${unit.locator.imageIndex}` : '图片', fraction: 0 };
          this.store.setStatus(doc.hash, 'indexing'); this.emit();
          try {
            const snapshotPath = await this.snapshot(doc);
            const recognized = await parser.recognize(snapshotPath, unit);
            if (this.paused || this.stopping) break;
            this.store.upsertUnit(doc.hash, { ...recognized, needsOcr: false });
          } catch (error) {
            if (this.paused || this.stopping) break;
            if (error instanceof SourceChangedError) break;
            this.store.upsertUnit(doc.hash, { ...unit, needsOcr: false, ocrError: errorText(error) });
          }
          this.finishContent(doc.hash); this.emit();
        }
      }));
      // Repair the small crash window between the final checkpoint and ready status.
      for (const hash of new Set(this.store.listDocuments().filter(d => d.status === 'indexing').map(d => d.hash))) this.finishContent(hash);
      if (!this.scanRequested) break;
    }
    if (!this.paused && !this.stopping && !this.scanRequested) {
      const referenced = this.store.referencedHashes();
      for (const hash of this.snapshots.keys()) if (!referenced.has(hash)) this.snapshots.delete(hash);
      await collectCache(this.options.cacheDir, referenced).catch(() => { this.progress.message = '部分缓存暂时无法清理，将在下次处理完成后重试。'; });
    }
    this.progress = { phase: this.paused ? 'paused' : 'idle', ...(this.progress.message ? { message: this.progress.message } : {}) };
    this.emit();
  }
  async waitForIdle() { await this.running; }
  async close() { this.stopping = true; await this.running; await Promise.all(this.ocrParsers.map(p => p.dispose())); this.store.close(); }
}
