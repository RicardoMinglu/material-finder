import { readFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import type { DocumentParser, ParsedUnit, ParserOptions, Rect, TextSpan } from '../shared/types.ts';
import { extractWord } from './parser-word.ts';
import { pdfImageRegions, translateCropSpans } from './parser-pdf-regions.ts';
import { pdfResourceDirectories } from './pdf-resources.ts';

const require = createRequire(import.meta.url);
export class ParserStoppedError extends Error {
  constructor() { super('索引已暂停'); this.name = 'ParserStoppedError'; }
}

export function normalizeRect(x: number, y: number, width: number, height: number, pageWidth: number, pageHeight: number): Rect {
  const left = Math.max(0, Math.min(1, x / pageWidth));
  const top = Math.max(0, Math.min(1, y / pageHeight));
  return { x: left, y: top, width: Math.max(0, Math.min(1 - left, width / pageWidth)), height: Math.max(0, Math.min(1 - top, height / pageHeight)) };
}

export function textNeedsOcr(text: string): boolean {
  const chars = text.replace(/\s/g, '');
  return chars.length < 30 || (chars.match(/[\ufffd\u0000]/g)?.length ?? 0) / Math.max(chars.length, 1) > 0.02;
}

/** Keep exact PDF text; OCR contributes only lines absent from its text layer. */
export function mergeNativeAndOcr(native: Pick<ParsedUnit, 'text' | 'spans'>, ocr: { text: string; spans: TextSpan[] }): { text: string; spans: TextSpan[] } {
  if (!native.text.trim()) return ocr;
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const nativeNormalized = normalize(native.text);
  const knownLines = new Set(native.text.split('\n').map(normalize));
  let text = native.text.trimEnd();
  const spans = [...native.spans];
  let sourceOffset = 0;
  for (const line of ocr.text.split('\n')) {
    const signature = normalize(line);
    const sourceStart = sourceOffset; sourceOffset += line.length + 1;
    if (!signature || knownLines.has(signature) || signature.length >= 6 && nativeNormalized.includes(signature)) continue;
    const start = text.length + 1; text += '\n' + line; knownLines.add(signature);
    for (const span of ocr.spans) {
      const left = Math.max(span.start, sourceStart), right = Math.min(span.end, sourceStart + line.length);
      if (left < right) spans.push({ ...span, start: start + left - sourceStart, end: start + right - sourceStart });
    }
  }
  return { text, spans };
}

export function imageTiles(height: number, tileHeight = 2600, overlap = 160): Array<{ top: number; height: number; keepTop: number; keepBottom: number }> {
  if (!Number.isFinite(height) || height <= 0 || tileHeight <= overlap || overlap < 0) throw new Error('图片尺寸无效。');
  const result = [];
  for (let top = 0; top < height; top += tileHeight - overlap) {
    const end = Math.min(top + tileHeight, height);
    result.push({ top, height: end - top, keepTop: top === 0 ? 0 : top + overlap / 2, keepBottom: end === height ? height : end - overlap / 2 });
    if (end === height) break;
  }
  return result;
}

let pdfModule: Promise<any> | undefined;
async function pdfjs(): Promise<any> {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.DOMMatrix ??= DOMMatrix; globals.ImageData ??= ImageData; globals.Path2D ??= Path2D;
  pdfModule ??= (async () => {
    // PDF.js treats every non-browser Electron process as a renderer. Our utility
    // process has Node APIs and no DOM. Import both modules with Node detection,
    // then restore Electron's original process descriptor before doing any work.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'type');
    const utilityProcess = !!process.versions.electron && (process as any).type !== 'browser' && typeof document === 'undefined';
    if (utilityProcess) Object.defineProperty(process, 'type', { configurable: true, enumerable: true, writable: true, value: 'browser' });
    try {
      const workerModule: string = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
      const [pdf] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import(workerModule),
      ]);
      return pdf;
    } finally {
      if (utilityProcess) {
        if (descriptor) Object.defineProperty(process, 'type', descriptor);
        else delete (process as any).type;
      }
    }
  })();
  return pdfModule;
}
function unpacked(filename: string): string { return filename.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'); }

export function createDocumentParser(options: ParserOptions): DocumentParser {
  let ocrWorker: any;
  let workerPromise: Promise<any> | undefined;
  let cachedPdf: { path: string; revision: string; document: any } | undefined;
  let disposed = false;
  const checkStop = () => { if (disposed || options.shouldStop?.()) throw new ParserStoppedError(); };

  async function openPdf(filename: string): Promise<any> {
    const pdf = await pdfjs();
    // Binary resources are physically unpacked so PDF.js can use Node's raw fs
    // APIs without relying on Electron's virtual app.asar filesystem hooks.
    const root = unpacked(path.dirname(require.resolve('pdfjs-dist/package.json')));
    const task = pdf.getDocument({ data: new Uint8Array(await readFile(filename)), useSystemFonts: true,
      isEvalSupported: false, verbosity: 0, cMapPacked: true,
      ...pdfResourceDirectories(root) });
    try { return await task.promise; }
    catch (error) { await task.destroy().catch(() => {}); throw error; }
  }

  async function worker(): Promise<any> {
    if (!workerPromise) workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      const workerPath = unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js'));
      const corePath = unpacked(path.dirname(require.resolve('tesseract.js-core/package.json')));
      await mkdir(options.cacheDir, { recursive: true });
      const instance = await createWorker(['chi_sim', 'eng'], 1, {
        workerPath, corePath, langPath: options.ocrDataDir, gzip: false, cacheMethod: 'none',
        logger: (message: any) => { if (typeof message.progress === 'number') options.onProgress?.(message.progress); },
      }, { tessedit_load_sublangs: '' });
      await instance.setParameters({ preserve_interword_spaces: '1' });
      ocrWorker = instance;
      return instance;
    })().catch(error => { workerPromise = undefined; throw error; });
    return workerPromise;
  }

  async function recognizeBitmap(bitmap: any, width: number, height: number): Promise<{ text: string; spans: TextSpan[]; confidence: number }> {
    const engine = await worker();
    let text = '';
    const spans: TextSpan[] = [];
    const recent: Array<{ text: string; center: number }> = [];
    let confidence = 0, confidenceCount = 0;
    const scale = width < 1000 ? Math.min(2, 1600 / width) : Math.min(1, 2400 / width);
    const tiles = imageTiles(height);
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
      checkStop();
      const tile = tiles[tileIndex];
      const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(tile.height * scale)));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, tile.top, width, tile.height, 0, 0, canvas.width, canvas.height);
      const { data } = await engine.recognize(await canvas.encode('png'), {}, { text: true, blocks: true });
      checkStop();
      const lines = (data.blocks ?? []).flatMap((block: any) => (block.paragraphs ?? []).flatMap((paragraph: any) => paragraph.lines ?? []));
      if (!lines.length && data.text?.trim()) {
        // A coarse box keeps text searchable even if the engine returns no word geometry.
        lines.push({ text: data.text, bbox: { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height }, words: [] });
      }
      for (const line of lines) {
        const value = String(line.text ?? '').trim();
        if (!value) continue;
        const box = line.bbox;
        if (!box) continue;
        const center = (box.y0 + box.y1) / (2 * scale) + tile.top;
        if (center < tile.keepTop || center >= tile.keepBottom && tileIndex < tiles.length - 1) continue;
        const signature = value.replace(/\s/g, '');
        const lineHeight = Math.max(1, (box.y1 - box.y0) / scale);
        if (recent.some(previous => previous.text === signature && Math.abs(previous.center - center) < lineHeight)) continue;
        recent.push({ text: signature, center }); if (recent.length > 8) recent.shift();
        if (text) text += '\n';
        const start = text.length; text += value;
        let cursor = 0;
        let wordCount = 0;
        for (const word of line.words ?? []) {
          const wordText = String(word.text ?? '').trim();
          const at = wordText ? value.indexOf(wordText, cursor) : -1;
          if (at < 0 || !word.bbox) continue;
          const b = word.bbox;
          spans.push({ start: start + at, end: start + at + wordText.length,
            rect: normalizeRect(b.x0 / scale, b.y0 / scale + tile.top, (b.x1 - b.x0) / scale, (b.y1 - b.y0) / scale, width, height) });
          cursor = at + wordText.length; wordCount++;
        }
        if (!wordCount) spans.push({ start, end: text.length,
          rect: normalizeRect(box.x0 / scale, box.y0 / scale + tile.top, (box.x1 - box.x0) / scale, (box.y1 - box.y0) / scale, width, height) });
      }
      if (Number.isFinite(data.confidence)) { confidence += data.confidence; confidenceCount++; }
      canvas.width = 1; canvas.height = 1;
      options.onProgress?.((tileIndex + 1) / tiles.length);
    }
    return { text, spans, confidence: confidenceCount ? confidence / confidenceCount : 0 };
  }

  return {
    async *extract(filePath, kind, contentHash) {
      checkStop();
      if (kind === 'word') { yield* extractWord(filePath, contentHash, options, checkStop); return; }
      if (kind === 'image') {
        const image = await loadImage(filePath);
        yield { key: 'image:1', ordinal: 0, locator: { type: 'image' }, text: '', spans: [],
          width: image.width, height: image.height, imagePath: filePath, needsOcr: true };
        return;
      }
      const pdf = await pdfjs();
      const doc = await openPdf(filePath);
      const imageOps = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask']
        .map(name => pdf.OPS[name]).filter(value => value !== undefined));
      try {
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
          checkStop();
          const page = await doc.getPage(pageNumber);
          try {
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const spans: TextSpan[] = [];
            let text = '';
            for (const item of content.items) {
              if (typeof item.str !== 'string' || !item.str) continue;
              const transform = pdf.Util.transform(viewport.transform, item.transform);
              const height = Math.hypot(transform[2], transform[3]) || item.height || 1;
              const start = text.length; text += item.str;
              spans.push({ start, end: text.length, rect: normalizeRect(transform[4], transform[5] - height * 0.85,
                Math.abs(item.width), height, viewport.width, viewport.height) });
              text += item.hasEOL ? '\n' : ' ';
            }
            const operations = await page.getOperatorList();
            const hasImages = operations.fnArray.some((op: number) => imageOps.has(op));
            yield { key: `pdf:${pageNumber}`, ordinal: pageNumber - 1, locator: { type: 'pdf', page: pageNumber },
              text: text.trimEnd(), spans, width: viewport.width, height: viewport.height,
              needsOcr: hasImages || textNeedsOcr(text) };
          } finally { page.cleanup(); }
        }
      } finally { await doc.loadingTask.destroy(); }
    },
    async recognize(filePath, unit) {
      checkStop();
      let bitmap: any;
      let page: any;
      let regions: Rect[] | null = null;
      try {
        if (unit.locator.type === 'pdf') {
          const fingerprint = 'contentHash' in unit ? unit.contentHash : undefined;
          const info = fingerprint ? undefined : await stat(filePath, { bigint: true });
          const revision = fingerprint ?? `${info!.size}:${info!.mtimeNs}:${info!.ctimeNs}`;
          if (cachedPdf?.path !== filePath || cachedPdf.revision !== revision) {
            if (cachedPdf) await cachedPdf.document.loadingTask.destroy();
            cachedPdf = undefined;
            cachedPdf = { path: filePath, revision, document: await openPdf(filePath) };
          }
          page = await cachedPdf.document.getPage(unit.locator.page);
          const base = page.getViewport({ scale: 1 });
          if (!textNeedsOcr(unit.text)) regions = pdfImageRegions(await page.getOperatorList(), (await pdfjs()).OPS, base);
          if (regions?.length === 0) return { ...unit, needsOcr: false, ocrError: undefined };
          const viewport = page.getViewport({ scale: Math.min(3, 2400 / base.width) });
          bitmap = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: bitmap.getContext('2d'), viewport, background: '#ffffff' }).promise;
        } else bitmap = await loadImage(unit.locator.type === 'image' ? filePath : unit.imagePath ?? filePath);
        let result: { text: string; spans: TextSpan[]; confidence: number };
        if (regions) {
          result = { text: '', spans: [], confidence: 0 };
          for (const region of regions) {
            checkStop();
            const left = Math.floor(region.x * bitmap.width), top = Math.floor(region.y * bitmap.height);
            const width = Math.max(1, Math.min(bitmap.width, Math.ceil((region.x + region.width) * bitmap.width)) - left);
            const height = Math.max(1, Math.min(bitmap.height, Math.ceil((region.y + region.height) * bitmap.height)) - top);
            const crop = createCanvas(width, height);
            try {
              crop.getContext('2d').drawImage(bitmap, left, top, width, height, 0, 0, width, height);
              const recognized = await recognizeBitmap(crop, width, height);
              const translated = translateCropSpans(recognized.spans,
                { x: left / bitmap.width, y: top / bitmap.height, width: width / bitmap.width, height: height / bitmap.height });
              const offset = result.text.length + (result.text ? 1 : 0);
              result.text += (result.text ? '\n' : '') + recognized.text;
              result.spans.push(...translated.map(span => ({ ...span, start: span.start + offset, end: span.end + offset })));
              result.confidence += recognized.confidence / regions.length;
            } finally { crop.width = 1; crop.height = 1; }
          }
        } else result = await recognizeBitmap(bitmap, bitmap.width, bitmap.height);
        const merged = mergeNativeAndOcr(unit, result);
        return { ...unit, ...result, ...merged,
          width: bitmap.width, height: bitmap.height, needsOcr: false, ocrError: undefined };
      } finally {
        page?.cleanup();
        if (page && bitmap) { bitmap.width = 1; bitmap.height = 1; }
      }
    },
    async dispose() {
      disposed = true;
      if (workerPromise) { try { await workerPromise; } catch { /* initialization already reported */ } }
      if (ocrWorker) await ocrWorker.terminate();
      if (cachedPdf) await cachedPdf.document.loadingTask.destroy();
      ocrWorker = undefined; cachedPdf = undefined; workerPromise = undefined;
    },
  };
}
