import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  DocumentList, DocumentListQuery, AppState, FileKind, FileStatus, IndexProgress, Library, ParsedUnit, SearchQuery,
  SearchResponse, SourceDocument, StoredUnit,
} from '../shared/types.js';
import {
  escapeLike, matchText, matchUnit, normalizeText, prepareQuery, quoteFts, rankText, rectsFor,
  snippetFor, type NormalizedText,
} from './search.js';

type Row = Record<string, unknown>;
export type SourceInput = Pick<SourceDocument, 'path' | 'relativePath' | 'name' | 'kind' | 'size' | 'mtime' | 'hash'>;

const documentSelect = `SELECT s.*, c.status, c.error,
  (SELECT COUNT(*) FROM units u WHERE u.content_hash=s.hash) AS unit_count
  FROM sources s JOIN contents c ON c.hash=s.hash`;

function sourceFrom(row: Row): SourceDocument {
  return {
    id: Number(row.id), path: String(row.path), relativePath: String(row.relative_path),
    name: String(row.name), kind: row.kind as FileKind, size: Number(row.size),
    mtime: Number(row.mtime), hash: String(row.hash), status: row.status as FileStatus,
    unitCount: Number(row.unit_count), ...(row.error ? { error: String(row.error) } : {}),
  };
}

function unitFrom(row: Row): StoredUnit {
  return {
    id: Number(row.id), contentHash: String(row.content_hash), key: String(row.unit_key),
    ordinal: Number(row.ordinal), locator: JSON.parse(String(row.locator)),
    text: String(row.text), spans: JSON.parse(String(row.spans)), needsOcr: Boolean(row.needs_ocr),
    ...(row.width != null ? { width: Number(row.width) } : {}),
    ...(row.height != null ? { height: Number(row.height) } : {}),
    ...(row.image_path ? { imagePath: String(row.image_path) } : {}),
    ...(row.ocr_error ? { ocrError: String(row.ocr_error) } : {}),
    ...(row.confidence != null ? { confidence: Number(row.confidence) } : {}),
  };
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly hasSearchCover: boolean;
  private searchCache?: { key: string; capacity: number; total: number; matches: Candidate[] };
  revision(): string {
    return `${this.db.prepare('PRAGMA data_version').get()!.data_version}:${this.db.prepare('SELECT total_changes() AS n').get()!.n}`;
  }
  referencedHashes(): Set<string> { return new Set(this.db.prepare('SELECT hash FROM contents').all().map(r => String(r.hash))); }
  listPage(query: DocumentListQuery = {}): DocumentList {
    return this.transaction(() => {
      const conditions: string[] = [], args: SQLInputValue[] = [];
      if (query.text) { conditions.push("s.relative_path LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(query.text)}%`); }
      if (query.status) { conditions.push('c.status=?'); args.push(query.status); }
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM sources s JOIN contents c ON c.hash=s.hash' + where).get(...args)!.n);
      const files = this.db.prepare(documentSelect + where + ' ORDER BY s.relative_path COLLATE NOCASE,s.id LIMIT ? OFFSET ?')
        .all(...args, Math.min(100, Math.max(1, query.limit ?? 100)), Math.max(0, query.offset ?? 0)).map(sourceFrom);
      return { files, total, revision: this.revision() };
    }, false);
  }
  adjacentUnits(unit: StoredUnit): { before: StoredUnit[]; after: StoredUnit[] } {
    const before = this.db.prepare('SELECT * FROM units WHERE content_hash=? AND (ordinal<? OR (ordinal=? AND id<?)) ORDER BY ordinal DESC,id DESC LIMIT 2')
      .all(unit.contentHash, unit.ordinal, unit.ordinal, unit.id).map(unitFrom).reverse();
    const after = this.db.prepare('SELECT * FROM units WHERE content_hash=? AND (ordinal>? OR (ordinal=? AND id>?)) ORDER BY ordinal,id LIMIT 2')
      .all(unit.contentHash, unit.ordinal, unit.ordinal, unit.id).map(unitFrom);
    return { before, after };
  }
  previewParts(documentId: number, unitId: number, query: string) {
    return this.transaction(() => {
      const document = this.getDocument(documentId), unit = this.getUnit(unitId);
      if (!document || !unit || document.hash !== unit.contentHash) throw new Error('内容已更新，请重新搜索。');
      return { document, unit, ...this.adjacentUnits(unit), ...this.getMatch(unit, query) };
    }, false);
  }

  constructor(dbPath: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });
    if (options.readOnly) {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.hasSearchCover = Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='units_search_text'").get());
      return;
    }
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contents (
        hash TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
        extracted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        size INTEGER NOT NULL, mtime REAL NOT NULL,
        hash TEXT NOT NULL REFERENCES contents(hash)
      );
      CREATE INDEX IF NOT EXISTS sources_hash ON sources(hash);
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_hash TEXT NOT NULL REFERENCES contents(hash) ON DELETE CASCADE,
        unit_key TEXT NOT NULL, ordinal INTEGER NOT NULL, locator TEXT NOT NULL,
        text TEXT NOT NULL, spans TEXT NOT NULL, width REAL, height REAL, image_path TEXT,
        needs_ocr INTEGER NOT NULL, ocr_error TEXT, confidence REAL,
        normalized TEXT NOT NULL, offsets TEXT NOT NULL,
        UNIQUE(content_hash, unit_key)
      );
      CREATE INDEX IF NOT EXISTS units_content ON units(content_hash, ordinal);
      CREATE INDEX IF NOT EXISTS units_search_text ON units(normalized, content_hash, ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
        normalized, content='units', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS units_insert AFTER INSERT ON units BEGIN
        INSERT INTO units_fts(rowid, normalized) VALUES (new.id,new.normalized);
      END;
      CREATE TRIGGER IF NOT EXISTS units_delete AFTER DELETE ON units BEGIN
        INSERT INTO units_fts(units_fts,rowid,normalized) VALUES ('delete',old.id,old.normalized);
      END;
      CREATE TRIGGER IF NOT EXISTS units_update AFTER UPDATE ON units BEGIN
        INSERT INTO units_fts(units_fts,rowid,normalized) VALUES ('delete',old.id,old.normalized);
        INSERT INTO units_fts(rowid,normalized) VALUES (new.id,new.normalized);
      END;
    `);
    this.hasSearchCover = true;
  }

  close(): void { this.db.close(); }

  private transaction<T>(run: () => T, immediate = true): T {
    this.db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getMeta<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }

  setMeta(key: string, value: unknown): void {
    if (value === undefined) { this.db.prepare('DELETE FROM meta WHERE key=?').run(key); return; }
    this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  setLibrary(rootPath: string): void {
    const root = path.resolve(rootPath);
    if (this.getMeta<string>('rootPath') === root) return;
    this.transaction(() => {
      this.db.exec('DELETE FROM sources; DELETE FROM contents; DELETE FROM meta;');
      this.setMeta('rootPath', root);
      this.setMeta('skipped', 0);
      this.setMeta('paused', false);
    });
  }

  getLibrary(): Library | null {
    const rootPath = this.getMeta<string>('rootPath');
    return rootPath ? { rootPath, name: path.basename(rootPath) || rootPath, missing: !existsSync(rootPath) } : null;
  }

  upsertSource(source: SourceInput): SourceDocument {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO contents(hash) VALUES (?)').run(source.hash);
      this.db.prepare(`INSERT INTO sources(path,relative_path,name,kind,size,mtime,hash)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
        relative_path=excluded.relative_path,name=excluded.name,kind=excluded.kind,
        size=excluded.size,mtime=excluded.mtime,hash=excluded.hash`).run(
        source.path, source.relativePath.replace(/\\/g, '/'), source.name, source.kind,
        source.size, source.mtime, source.hash,
      );
      this.db.prepare('DELETE FROM contents WHERE NOT EXISTS (SELECT 1 FROM sources WHERE sources.hash=contents.hash)').run();
      return sourceFrom(this.db.prepare(`${documentSelect} WHERE s.path=?`).get(source.path)!);
    });
  }

  listDocuments(): SourceDocument[] {
    return this.db.prepare(`${documentSelect} ORDER BY s.relative_path COLLATE NOCASE,s.id`).all().map(sourceFrom);
  }

  getDocument(id: number): SourceDocument | undefined {
    const row = this.db.prepare(`${documentSelect} WHERE s.id=?`).get(id);
    return row ? sourceFrom(row) : undefined;
  }

  sourceForHash(hash: string): SourceDocument | undefined {
    const row = this.db.prepare(documentSelect + ' WHERE s.hash=? ORDER BY s.id LIMIT 1').get(hash);
    return row ? sourceFrom(row) : undefined;
  }

  removeSource(id: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sources WHERE id=?').run(id);
      this.db.prepare('DELETE FROM contents WHERE NOT EXISTS (SELECT 1 FROM sources WHERE sources.hash=contents.hash)').run();
    });
  }

  setStatus(hash: string, status: FileStatus, error?: string): void {
    this.db.prepare('UPDATE contents SET status=?,error=? WHERE hash=?').run(status, error ?? null, hash);
  }

  upsertUnit(hash: string, unit: ParsedUnit): StoredUnit {
    const normalized = normalizeText(unit.text);
    this.db.prepare(`INSERT INTO units(content_hash,unit_key,ordinal,locator,text,spans,width,height,
        image_path,needs_ocr,ocr_error,confidence,normalized,offsets)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(content_hash,unit_key) DO UPDATE SET
        ordinal=excluded.ordinal,locator=excluded.locator,text=excluded.text,spans=excluded.spans,
        width=excluded.width,height=excluded.height,image_path=excluded.image_path,
        needs_ocr=excluded.needs_ocr,ocr_error=excluded.ocr_error,confidence=excluded.confidence,
        normalized=excluded.normalized,offsets=excluded.offsets`).run(
      hash, unit.key, unit.ordinal, JSON.stringify(unit.locator), unit.text, JSON.stringify(unit.spans),
      unit.width ?? null, unit.height ?? null, unit.imagePath ?? null, Number(unit.needsOcr),
      unit.ocrError ?? null, unit.confidence ?? null, normalized.text,
      JSON.stringify({ starts: normalized.starts, ends: normalized.ends }),
    );
    return unitFrom(this.db.prepare('SELECT * FROM units WHERE content_hash=? AND unit_key=?').get(hash, unit.key)!);
  }

  getUnits(hash: string): StoredUnit[] {
    return this.db.prepare('SELECT * FROM units WHERE content_hash=? ORDER BY ordinal,id').all(hash).map(unitFrom);
  }

  getUnit(id: number): StoredUnit | undefined {
    const row = this.db.prepare('SELECT * FROM units WHERE id=?').get(id);
    return row ? unitFrom(row) : undefined;
  }

  clearContent(hash: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM units WHERE content_hash=?').run(hash);
      this.db.prepare("UPDATE contents SET extracted=0,status='queued',error=NULL WHERE hash=?").run(hash);
    });
  }

  markContentExtracted(hash: string): void {
    this.db.prepare('UPDATE contents SET extracted=1 WHERE hash=?').run(hash);
  }

  isContentExtracted(hash: string): boolean {
    return Boolean(this.db.prepare('SELECT extracted FROM contents WHERE hash=?').get(hash)?.extracted);
  }

  getPendingOcr(): Array<{ document: SourceDocument; unit: StoredUnit }> {
    const rows = this.db.prepare(`SELECT u.*,
        (SELECT MIN(s.id) FROM sources s WHERE s.hash=u.content_hash) AS document_id
      FROM units u JOIN contents c ON c.hash=u.content_hash
      WHERE u.needs_ocr=1 AND u.ocr_error IS NULL AND c.status!='error'
      ORDER BY document_id,u.ordinal,u.id`).all();
    return rows.flatMap(row => {
      const document = this.getDocument(Number(row.document_id));
      return document ? [{ document, unit: unitFrom(row) }] : [];
    });
  }

  setSkipped(count: number): void { this.setMeta('skipped', Math.max(0, Math.floor(count))); }

  getState(progress?: IndexProgress): AppState {
    const rows = this.db.prepare('SELECT s.relative_path,s.kind,c.status FROM sources s JOIN contents c ON c.hash=s.hash').all();
    const folders = new Set<string>();
    const counts: Record<FileKind, number> = { pdf: 0, image: 0, word: 0 };
    const statuses: Record<FileStatus, number> = { queued: 0, indexing: 0, ready: 0, error: 0 };
    for (const row of rows) {
      counts[row.kind as FileKind]++; statuses[row.status as FileStatus]++;
      const segments = String(row.relative_path).split('/').slice(0, -1);
      for (let i = 1; i <= segments.length; i++) folders.add(segments.slice(0, i).join('/'));
    }
    return {
      library: this.getLibrary(), counts, revision: this.revision(), folders: [...folders].sort((a,b) => a.localeCompare(b,'zh-CN')),
      progress: progress ?? { phase: this.getMeta<boolean>('paused') ? 'paused' : 'idle' },
      stats: {
        total: rows.length, ready: statuses.ready, queued: statuses.queued, indexing: statuses.indexing, errors: statuses.error,
        units: Number(this.db.prepare('SELECT COUNT(*) AS n FROM units').get()!.n),
        ocrPending: Number(this.db.prepare('SELECT COUNT(*) AS n FROM units WHERE needs_ocr=1').get()!.n),
        skipped: this.getMeta<number>('skipped') ?? 0,
      },
    };
  }

  getMatch(unit: StoredUnit, query: string): ReturnType<typeof matchUnit> { return matchUnit(unit, query); }

  search(query: SearchQuery): SearchResponse {
    // The indexing utility process can replace sources while this connection searches.
    // A WAL read snapshot keeps result units and their source documents consistent.
    return this.transaction(() => this.searchSnapshot(query), false);
  }

  private searchSnapshot(query: SearchQuery): SearchResponse {
    const started = performance.now(), prepared = prepareQuery(query.text);
    if (!prepared.terms.length) return { hits: [], total: 0, elapsedMs: performance.now() - started };
    const conditions: string[] = [], parameters: SQLInputValue[] = [];
    const longTerms = prepared.terms.filter(term => [...term].length >= 3);
    if (longTerms.length) {
      conditions.push('u.id IN (SELECT rowid FROM units_fts WHERE units_fts MATCH ?)');
      parameters.push(longTerms.map(quoteFts).join(' AND '));
    }
    for (const term of prepared.terms.filter(term => [...term].length < 3)) {
      conditions.push("u.normalized LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(term)}%`);
    }
    if (query.kind) { conditions.push('s.kind=?'); parameters.push(query.kind); }
    if (query.folder) {
      const folder = query.folder.replace(/\\/g, '/').replace(/\/+$/, '');
      conditions.push("s.relative_path LIKE ? ESCAPE '\\'");
      parameters.push(`${escapeLike(folder)}/%`);
    }
    // LIKE cannot use trigram lookup for one or two characters. Scan the compact
    // covering index instead of document rows containing large geometry/offset JSON.
    const unitTable = !longTerms.length && this.hasSearchCover ? 'units u INDEXED BY units_search_text' : 'units u';
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 30)));
    const capacity = offset + limit;
    const key = JSON.stringify([this.revision(), prepared, query.kind, query.folder]);
    if (!this.searchCache || this.searchCache.key !== key || (this.searchCache.capacity < capacity && this.searchCache.total > this.searchCache.capacity)) {
      const heap = new BestCandidates(capacity);
      let total = 0;
      const statement = this.db.prepare(`SELECT u.id,u.ordinal,u.normalized,MIN(s.id) AS document_id
        FROM ${unitTable} JOIN sources s ON s.hash=u.content_hash
        WHERE ${conditions.join(' AND ')} GROUP BY u.id`);
      for (const row of statement.iterate(...parameters)) {
        const match = rankText(String(row.normalized), prepared);
        if (!match) continue;
        total++;
        heap.add({ id: Number(row.id), ordinal: Number(row.ordinal), documentId: Number(row.document_id), ...match });
      }
      this.searchCache = { key, capacity, total, matches: heap.sorted() };
    }
    const { matches, total } = this.searchCache;
    const fetchUnit = this.db.prepare('SELECT * FROM units WHERE id=?');
    const countCopies = this.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE hash=?');
    const sourceCache = new Map<number, SourceDocument>();
    const copiesCache = new Map<string, number>();
    const hits = matches.slice(offset, offset + limit).map(candidate => {
      const fullRow = fetchUnit.get(candidate.id)!;
      const offsets = JSON.parse(String(fullRow.offsets)) as Omit<NormalizedText, 'text'>;
      const match = matchText({ text: String(fullRow.normalized), ...offsets }, prepared)!;
      const unit = unitFrom(fullRow), documentId = candidate.documentId;
      if (!sourceCache.has(documentId)) sourceCache.set(documentId, this.getDocument(documentId)!);
      const document = sourceCache.get(documentId)!;
      if (!copiesCache.has(document.hash)) copiesCache.set(document.hash, Number(countCopies.get(document.hash)!.count));
      return {
        documentId: document.id, unitId: unit.id, name: document.name,
        relativePath: document.relativePath, kind: document.kind, locator: unit.locator,
        ...snippetFor(unit.text, match), rects: rectsFor(unit.spans, match.highlights),
        exact: match.exact, ocrPending: unit.needsOcr, sourceCount: copiesCache.get(document.hash)!,
      };
    });
    return { hits, total, elapsedMs: performance.now() - started };
  }
}

interface Candidate { id: number; ordinal: number; documentId: number; exact: boolean; proximity: number }
function compare(a: Candidate, b: Candidate): number {
  return Number(b.exact)-Number(a.exact) || a.proximity-b.proximity || a.documentId-b.documentId || a.ordinal-b.ordinal || a.id-b.id;
}
/** Max heap of only the best offset+limit candidates. Never stores page text. */
class BestCandidates {
  private values: Candidate[] = [];
  constructor(private capacity: number) {}
  add(value: Candidate) {
    const a = this.values;
    if (a.length < this.capacity) {
      a.push(value); let i=a.length-1;
      while(i>0) { const p=(i-1)>>1; if(compare(a[p]!,a[i]!)>=0)break; [a[p],a[i]]=[a[i]!,a[p]!]; i=p; }
    } else if (compare(value,a[0]!)<0) {
      a[0]=value; let i=0;
      for (;;) { let child=i*2+1; if(child>=a.length)break; if(child+1<a.length && compare(a[child+1]!,a[child]!)>0)child++;
        if(compare(a[i]!,a[child]!)>=0)break; [a[i],a[child]]=[a[child]!,a[i]!];i=child; }
    }
  }
  sorted() { return this.values.sort(compare); }
}
