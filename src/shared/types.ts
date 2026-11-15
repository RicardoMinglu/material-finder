export type FileKind = 'pdf' | 'image' | 'word';
export type FileStatus = 'queued' | 'indexing' | 'ready' | 'error';
export interface Rect { x: number; y: number; width: number; height: number }
/** Coordinates are normalized [0,1], offsets are JS UTF-16 offsets into text. */
export interface TextSpan { start: number; end: number; rect: Rect }
export type Locator = { type: 'pdf'; page: number } | { type: 'image' } |
  { type: 'word'; section: string; paragraph: number; imageIndex?: number };
export interface ParsedUnit {
  key: string; ordinal: number; locator: Locator; text: string; spans: TextSpan[];
  width?: number; height?: number; imagePath?: string; needsOcr: boolean;
  ocrError?: string; confidence?: number;
}
export interface StoredUnit extends ParsedUnit { id: number; contentHash: string }
export interface SourceDocument {
  id: number; path: string; relativePath: string; name: string; kind: FileKind;
  size: number; mtime: number; hash: string; status: FileStatus;
  unitCount: number; error?: string;
}
export interface Library { rootPath: string; name: string; missing: boolean }
export interface IndexProgress {
  phase: 'idle' | 'scanning' | 'extracting' | 'ocr' | 'paused';
  currentFile?: string; currentUnit?: string; fraction?: number; message?: string;
}
export interface LibraryStats {
  total: number; ready: number; queued: number; indexing: number;
  errors: number; units: number; ocrPending: number; skipped: number;
}
export interface AppState {
  library: Library | null; stats: LibraryStats; progress: IndexProgress;
  folders: string[]; counts: Record<FileKind, number>; revision: string;
}
export interface SearchQuery { text: string; kind?: FileKind; folder?: string; offset?: number; limit?: number }
export interface SearchHit {
  documentId: number; unitId: number; name: string; relativePath: string; kind: FileKind;
  locator: Locator; snippet: string; highlights: Array<{ start: number; end: number }>;
  rects: Rect[]; exact: boolean; ocrPending: boolean; sourceCount: number;
}
export interface SearchResponse { hits: SearchHit[]; total: number; elapsedMs: number }
export interface DocumentListQuery { text?: string; status?: FileStatus; offset?: number; limit?: number }
export interface DocumentList { files: SourceDocument[]; total: number; revision: string }
export interface StorageInfo { version: string; dataPath: string; indexBytes: number; cacheBytes: number }
export interface PreviewData {
  document: SourceDocument; unit: StoredUnit; sourceUrl: string; imageUrl?: string;
  rects: Rect[]; highlights: Array<{ start: number; end: number }>;
  neighbors: Array<{ side: 'before' | 'after'; id: number; locator: Locator; text: string; imageUrl?: string }>;
  previousUnitId?: number; nextUnitId?: number;
}
export interface DesktopApi {
  getState(): Promise<AppState>;
  listDocuments(query: DocumentListQuery): Promise<DocumentList>;
  storageInfo(): Promise<StorageInfo>;
  copyCitation(documentId: number, unitId: number, query: string): Promise<void>;
  chooseFolder(): Promise<AppState | null>;
  refresh(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  retry(documentId?: number): Promise<void>;
  search(query: SearchQuery): Promise<SearchResponse>;
  preview(documentId: number, unitId: number, query: string): Promise<PreviewData>;
  openSource(documentId: number): Promise<void>;
  revealSource(documentId: number): Promise<void>;
  onError(callback: (message: string) => void): () => void;
  onState(callback: (state: AppState) => void): () => void;
}
export interface ParserOptions {
  cacheDir: string; ocrDataDir: string;
  onProgress?: (fraction: number) => void;
  shouldStop?: () => boolean;
}
export interface DocumentParser {
  extract(filePath: string, kind: FileKind, contentHash: string): AsyncGenerator<ParsedUnit>;
  recognize(filePath: string, unit: StoredUnit | ParsedUnit): Promise<ParsedUnit>;
  dispose(): Promise<void>;
}
declare global { interface Window { materialFinder: DesktopApi } }
