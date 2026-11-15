import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { ParsedUnit, ParserOptions } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const OLE_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
type OrderedNode = Record<string, any>;

/** rtf-parser does not skip the ANSI fallback after \\uN; remove it before parsing. */
export function prepareRtf(buffer: Buffer): Buffer {
  const source = buffer.toString('latin1');
  const output: string[] = [];
  const stack: number[] = [];
  const nonTextDestinations = new Set(['pict', 'shppict', 'nonshppict', 'object', 'objdata', 'datastore', 'themedata',
    'colorschememapping', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'latentstyles', 'fldinst', 'info', 'stylesheet']);
  let uc = 1, fallback = 0, at = 0;
  while (at < source.length) {
    const character = source[at];
    if (character === '{' || character === '}') {
      if (character === '{') stack.push(uc); else uc = stack.pop() ?? 1;
      fallback = 0; output.push(character); at++; continue;
    }
    if (character !== '\\') {
      let end = at + 1;
      while (end < source.length && !'\\{}'.includes(source[end])) end++;
      const skip = Math.min(fallback, end - at);
      fallback -= skip; output.push(source.slice(at + skip, end)); at = end; continue;
    }
    const rest = source.slice(at, at + 64);
    const word = /^\\([a-z]+)(-?\d+)? ?/i.exec(rest);
    if (word) {
      const token = word[0], name = word[1].toLowerCase(), number = Number(word[2]);
      at += token.length;
      if (nonTextDestinations.has(name)) output.push('\\*', token);
      else if (name === 'uc') { uc = Math.max(0, Math.min(32, number)); output.push(token); }
      else if (name === 'u') {
        const signed = ((number % 65536) + 65536) % 65536;
        output.push(`\\u${signed > 32767 ? signed - 65536 : signed} `); fallback = uc;
      } else if (name === 'bin' && number >= 0) {
        output.push(token, source.slice(at, at + number)); at += number;
      } else if (fallback) fallback--;
      else output.push(token);
      continue;
    }
    const length = /^\\'[a-f\d]{2}/i.test(rest) ? 4 : Math.min(2, source.length - at);
    if (fallback) fallback--; else output.push(source.slice(at, at + length));
    at += length;
  }
  return Buffer.from(output.join(''), 'latin1');
}

export function detectWordFormat(buffer: Uint8Array): 'ole' | 'docx' | 'rtf' {
  const b = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (b.subarray(0, 8).equals(OLE_MAGIC)) return 'ole';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'docx';
  if (/^\s*\{\\rtf/i.test(b.subarray(0, 80).toString('latin1'))) return 'rtf';
  throw new Error('无法识别 Word 文件格式，仅支持 DOC、DOCX 和 RTF。');
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0006\u0008\u000e-\u001f]/g, '').replace(/\u0007/g, '\t').replace(/\u000b/g, '\n');
}

export function paragraphUnits(text: string, section: string, startOrdinal = 0): ParsedUnit[] {
  return cleanText(text).split(/\n+/).map(t => t.trim()).filter(Boolean).map((text, i) => ({
    key: `word:${section}:p:${i + 1}`, ordinal: startOrdinal + i,
    locator: { type: 'word', section, paragraph: i + 1 }, text, spans: [], needsOcr: false,
  }));
}

function parseXml(bytes: Uint8Array): OrderedNode[] {
  const xml = Buffer.from(bytes).toString('utf8');
  if (/<!DOCTYPE/i.test(xml)) throw new Error('不支持包含外部实体声明的 Word XML。');
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@',
    trimValues: false, parseTagValue: false, processEntities: true }).parse(xml);
}

function walk(nodes: OrderedNode[], fn: (name: string, children: OrderedNode[], attrs: Record<string, string>) => void): void {
  for (const node of nodes) for (const [name, value] of Object.entries(node)) {
    if (name === ':@' || name === '#text' || !Array.isArray(value)) continue;
    fn(name, value, node[':@'] ?? {});
    walk(value, fn);
  }
}

function imageExtension(data: Uint8Array, filename: string): string {
  const b = Buffer.from(data);
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b.subarray(0, 4).toString() === 'RIFF') return '.webp';
  if (b.subarray(0, 2).toString() === 'BM') return '.bmp';
  const ext = path.posix.extname(filename).toLowerCase();
  return ['.tif', '.tiff', '.gif', '.emf', '.wmf', '.svg'].includes(ext) ? ext : '.img';
}

export async function* extractWord(filePath: string, contentHash: string, options: ParserOptions, checkStop: () => void): AsyncGenerator<ParsedUnit> {
  const buffer = await readFile(filePath);
  const format = detectWordFormat(buffer);
  let ordinal = 0;
  if (format === 'ole') {
    const WordExtractor = require('word-extractor');
    const doc = await new WordExtractor().extract(buffer);
    const sections: Array<[string, string]> = [
      ['正文', doc.getBody()], ['文本框', doc.getTextboxes()], ['脚注', doc.getFootnotes()],
      ['尾注', doc.getEndnotes()], ['页眉', doc.getHeaders({ includeFooters: false })], ['页脚', doc.getFooters()],
    ];
    for (const [section, text] of sections) for (const unit of paragraphUnits(text ?? '', section, ordinal)) {
      checkStop(); ordinal++; yield unit;
    }
    if (!ordinal) throw new Error('Word 中未提取到可读文字，可能为加密文件或仅包含图片。');
    return;
  }
  if (format === 'rtf') {
    const parseRTF = require('rtf-parser');
    const document: any = await new Promise((resolve, reject) => {
      const parser = parseRTF((error: Error | null, doc: any) => error ? reject(error) : resolve(doc));
      parser.end(prepareRtf(buffer));
    });
    const flatten = (node: any): string => typeof node?.value === 'string' ? node.value :
      Array.isArray(node?.content) ? node.content.map(flatten).join('') : '';
    const text = (document.content ?? []).map((node: any) => flatten(node) + (Array.isArray(node?.content) ? '\n' : '')).join('');
    for (const unit of paragraphUnits(text, '正文')) { checkStop(); ordinal++; yield unit; }
    if (!ordinal) throw new Error('RTF 中未提取到可读文字。');
    return;
  }

  // Keep archive entries in memory; archive-controlled paths are never written to disk.
  const entries = unzipSync(buffer, { filter: entry => {
    if (entry.originalSize > 100 * 1024 * 1024) throw new Error('Word 内单个附件过大。');
    return /^word\/(?:[^/]+\.xml|_rels\/[^/]+\.rels|media\/)/.test(entry.name);
  } });
  if (!entries['word/document.xml']) throw new Error('DOCX 缺少正文 XML。');
  const parts: Array<[string, string]> = [['word/document.xml', '正文']];
  for (const [filename, section] of [['word/footnotes.xml', '脚注'], ['word/endnotes.xml', '尾注']] as const) {
    if (entries[filename]) parts.push([filename, section]);
  }
  for (const filename of Object.keys(entries).filter(n => /^word\/(header|footer)\d+\.xml$/.test(n)).sort()) {
    parts.push([filename, `${filename.includes('header') ? '页眉' : '页脚'} ${filename.match(/\d+/)?.[0]}`]);
  }
  const safeHash = /^[a-f0-9]{32,128}$/i.test(contentHash) ? contentHash : createHash('sha256').update(contentHash).digest('hex');
  const cacheDir = path.join(options.cacheDir, safeHash);
  let imageIndex = 0;
  for (const [partName, section] of parts) {
    checkStop();
    const relsName = `word/_rels/${path.posix.basename(partName)}.rels`;
    const relationships = new Map<string, string>();
    if (entries[relsName]) walk(parseXml(entries[relsName]), (name, _children, attrs) => {
      if (name.split(':').pop() === 'Relationship' && attrs['@TargetMode'] !== 'External') {
        const target = attrs['@Target'] ?? '';
        const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `word/${target}`);
        if (resolved.startsWith('word/media/')) relationships.set(attrs['@Id'], resolved);
      }
    });
    const paragraphs: OrderedNode[][] = [];
    walk(parseXml(entries[partName]), (name, children) => { if (name === 'w:p') paragraphs.push(children); });
    let paragraphNumber = 0;
    for (const paragraph of paragraphs) {
      checkStop(); paragraphNumber++;
      const events: Array<{ text: string } | { image: string }> = [];
      let pendingText = '';
      const flushText = () => { if (pendingText.trim()) events.push({ text: cleanText(pendingText).trim() }); pendingText = ''; };
      const visit = (nodes: OrderedNode[]) => {
        for (const node of nodes) for (const [name, children] of Object.entries(node)) {
          if (name === ':@' || name === '#text' || !Array.isArray(children)) continue;
          if (name === 'w:del' || name === 'w:p') continue;
          if (name === 'w:t') pendingText += children.map((n: any) => n['#text'] ?? '').join('');
          else if (name === 'w:tab') pendingText += '\t';
          else if (name === 'w:br' || name === 'w:cr') pendingText += '\n';
          else if (name === 'a:blip' || name === 'v:imagedata') {
            const attrs = node[':@'] ?? {};
            const relationship = attrs['@r:embed'] ?? attrs['@r:id'];
            const image = relationships.get(relationship);
            if (image && entries[image]) { flushText(); events.push({ image }); }
          } else visit(children);
        }
      };
      visit(paragraph); flushText();
      let textPart = 0;
      for (const event of events) {
        checkStop();
        if ('text' in event) {
          yield { key: `word:${section}:p:${paragraphNumber}:${++textPart}`, ordinal: ordinal++,
            locator: { type: 'word', section, paragraph: paragraphNumber }, text: event.text, spans: [], needsOcr: false };
        } else {
          const data = entries[event.image];
          const digest = createHash('sha256').update(data).digest('hex');
          const imagePath = path.join(cacheDir, `${digest}${imageExtension(data, event.image)}`);
          await mkdir(cacheDir, { recursive: true });
          await writeFile(imagePath, data);
          imageIndex++;
          yield { key: `word:${section}:image:${imageIndex}`, ordinal: ordinal++,
            locator: { type: 'word', section, paragraph: paragraphNumber, imageIndex },
            text: '', spans: [], imagePath, needsOcr: true };
        }
      }
    }
  }
  if (!ordinal) throw new Error('DOCX 中未找到文字或可识别的图片。');
}
