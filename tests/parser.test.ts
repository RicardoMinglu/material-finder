import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { createDocumentParser, imageTiles, normalizeRect, ParserStoppedError, textNeedsOcr, mergeNativeAndOcr } from '../src/core/parser.ts';
import { detectWordFormat } from '../src/core/parser-word.ts';
import { pdfImageRegions, translateCropSpans } from '../src/core/parser-pdf-regions.ts';
import { pdfResourceDirectories } from '../src/core/pdf-resources.ts';

GlobalFonts.registerFromPath(path.resolve('resources/fonts/NotoSansCJKsc-Regular.otf'), 'FixtureCJK');
const ocrDataDir = path.resolve('resources/ocr');
async function temporary(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'material-parser-test-'));
  const parser = createDocumentParser({ cacheDir: path.join(dir, 'cache'), ocrDataDir });
  t.after(async () => { await parser.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { dir, parser };
}

function pdfFixture(includeImage: boolean, text = 'A searchable examination question with forty characters.', raster?: { width: number; height: number; hex: string }): Buffer {
  const content = `BT /F1 12 Tf 20 160 Td (${text}) Tj ET\n` +
    (includeImage ? raster ? 'q 200 0 0 60 40 20 cm /Im0 Do Q\n' : 'q 80 0 0 80 20 20 cm /Im0 Do Q\n' : '');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    raster ? `<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${raster.hex.length + 1} >>\nstream\n${raster.hex}>\nendstream` :
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('PDF.js accepts all resource directories for Windows installs with spaces and Chinese characters', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const roots = [
    String.raw`D:\Program Files\material-finder\resources\app.asar\node_modules\pdfjs-dist`,
    String.raw`C:\应用程序\资料快搜 #1\resources\app.asar.unpacked\node_modules\pdfjs-dist` + '\\',
    String.raw`\\server\共享目录\资料快搜\node_modules\pdfjs-dist`,
    '/Applications/资料快搜.app/Contents/Resources/app.asar/node_modules/pdfjs-dist/',
  ];
  for (const root of roots) {
    const resources = pdfResourceDirectories(root);
    for (const [key, value] of Object.entries(resources)) {
      // Exercise the real PDF.js validator for each option, not just our helper.
      assert.throws(() => pdfjs.getDocument({ data: new Uint8Array(pdfFixture(false)), [key]: value.slice(0, -1) }), /must include trailing slash/);
      const task = pdfjs.getDocument({ data: new Uint8Array(pdfFixture(false)), ...resources, verbosity: 0 });
      try { assert.equal((await task.promise).numPages, 1); }
      finally { await task.destroy(); }
    }
    assert.ok(Object.values(resources).every(value => value.endsWith('/') && !value.includes('\\') && !value.startsWith('file:')));
  }
});

test('normalized PDF resource directories read bundled binary data as filesystem paths', async t => {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), 'material-resources-')), 'Program Files', '资料快搜 #1');
  t.after(() => rm(path.dirname(path.dirname(root)), { recursive: true, force: true }));
  const resources = pdfResourceDirectories(root);
  for (const directory of Object.values(resources)) {
    await mkdir(directory, { recursive: true });
    const name = 'resource #1.bin', bytes = Buffer.from([0, 1, 128, 255]);
    await writeFile(directory + name, bytes);
    assert.deepEqual(await readFile(directory + name), bytes);
  }
  const require = createRequire(import.meta.url);
  const bundled = pdfResourceDirectories(path.dirname(require.resolve('pdfjs-dist/package.json')));
  assert.ok((await readFile(bundled.cMapUrl + 'Adobe-GB1-UCS2.bcmap')).length > 0);
  assert.ok((await readFile(bundled.standardFontDataUrl + 'LiberationSans-Regular.ttf')).length > 0);
  assert.ok((await readFile(bundled.wasmUrl + 'openjpeg.wasm')).length > 0);
});

test('file signatures override misleading Word extensions', () => {
  assert.equal(detectWordFormat(Buffer.from('{\\rtf1\\ansi test}')), 'rtf');
  assert.equal(detectWordFormat(Buffer.from('d0cf11e0a1b11ae1', 'hex')), 'ole');
  assert.equal(detectWordFormat(Buffer.from('PK\x03\x04')), 'docx');
  assert.throws(() => detectWordFormat(Buffer.from('<html>unsupported</html>')));
});

test('RTF stored as DOC preserves CP936 Chinese and Unicode paragraphs', async t => {
  const { dir, parser } = await temporary(t);
  const file = path.join(dir, 'legacy.doc');
  await writeFile(file, "{\\rtf1\\ansi\\ansicpg936 \\'d6\\'d0\\'ce\\'c4\\par \\uc1\\u27979?\\u-29739?}");
  const units = await Array.fromAsync(parser.extract(file, 'word', 'rtf-fixture'));
  assert.deepEqual(units.map(u => u.text), ['中文', '测试']);
  assert.equal(units[1].locator.type, 'word');
  assert.equal(units[1].ordinal, 1);
});

test('RTF image and object payloads are not indexed as hexadecimal body text', async t => {
  const { dir, parser } = await temporary(t);
  const file = path.join(dir, 'picture.doc');
  await writeFile(file, '{\\rtf1 Before{\\pict\\pngblip 89504e47aabbccdd}{\\object{\\objdata deadbeef}} After\\par}');
  const units = await Array.fromAsync(parser.extract(file, 'word', 'rtf-image'));
  assert.deepEqual(units.map(u => u.text), ['Before After']);
});

test('DOCX image order follows XML relationships, not ZIP filenames, and caches images safely', async t => {
  const { dir, parser } = await temporary(t);
  const canvas = createCanvas(20, 20); canvas.getContext('2d').fillRect(0, 0, 20, 20);
  const png = await canvas.encode('png');
  const xml = '<w:document><w:body><w:p><w:r><w:t>中文 &amp; 标题</w:t></w:r></w:p>' +
    '<w:p><w:r><w:drawing><a:blip r:embed="rSecond"/></w:drawing></w:r></w:p>' +
    '<w:p><w:r><w:t>题目</w:t></w:r><w:r><w:drawing><a:blip r:embed="rFirst"/></w:drawing></w:r></w:p></w:body></w:document>';
  const data = zipSync({
    'word/document.xml': strToU8(xml),
    'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="rFirst" Target="media/z.png"/><Relationship Id="rSecond" Target="media/a.png"/></Relationships>'),
    'word/media/z.png': png, 'word/media/a.png': png,
  });
  const file = path.join(dir, 'images.docx'); await writeFile(file, data);
  const units = await Array.fromAsync(parser.extract(file, 'word', '../../unsafe-hash'));
  assert.deepEqual(units.map(u => u.text), ['中文 & 标题', '', '题目', '']);
  const images = units.filter(u => u.imagePath);
  assert.equal(images.length, 2);
  assert.equal(images[0].locator.type === 'word' && images[0].locator.imageIndex, 1);
  assert.equal(images[1].locator.type === 'word' && images[1].locator.imageIndex, 2);
  assert.equal(images[0].imagePath, images[1].imagePath, 'identical image bytes share cached file');
  assert.ok(images[0].imagePath!.startsWith(path.join(dir, 'cache') + path.sep));
  assert.deepEqual(await readFile(images[0].imagePath!), png);
  assert.equal(images[0].needsOcr, true);
});

test('PDF native text has geometry and pages with both text and images still request OCR', async t => {
  const { dir, parser } = await temporary(t);
  for (const images of [false, true]) {
    const file = path.join(dir, `${images}.pdf`); await writeFile(file, pdfFixture(images));
    const units = await Array.fromAsync(parser.extract(file, 'pdf', `fixture-${images}`));
    assert.equal(units.length, 1);
    assert.match(units[0].text, /searchable examination question/);
    assert.equal(units[0].needsOcr, images);
    assert.ok(units[0].spans.length > 0);
    for (const span of units[0].spans) {
      assert.ok(span.start < span.end && span.end <= units[0].text.length);
      assert.ok(span.rect.x >= 0 && span.rect.y >= 0 && span.rect.x + span.rect.width <= 1 && span.rect.y + span.rect.height <= 1);
    }
  }
});

test('long-image tile ownership covers the image without duplicate overlap regions', () => {
  const tiles = imageTiles(8689);
  assert.ok(tiles.length >= 4);
  assert.equal(tiles[0].keepTop, 0);
  assert.equal(tiles.at(-1)!.keepBottom, 8689);
  for (let i = 1; i < tiles.length; i++) {
    assert.equal(tiles[i - 1].keepBottom, tiles[i].keepTop);
    assert.ok(tiles[i].top < tiles[i - 1].top + tiles[i - 1].height);
  }
  assert.deepEqual(normalizeRect(-10, 90, 150, 80, 100, 100), { x: 0, y: 0.9, width: 1, height: 0.09999999999999998 });
  assert.equal(textNeedsOcr('A'.repeat(40)), false);
  assert.equal(textNeedsOcr('A'.repeat(40) + '\ufffd\ufffd'), true);
});

test('OCR preserves native PDF text while adding unseen image text with correct offsets', () => {
  const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.1 };
  const merged = mergeNativeAndOcr({ text: '中国石化招聘考试\nOriginal 4827', spans: [{ start: 0, end: 8, rect }] },
    { text: '中国 石化招聘 考试\n图片中的新题目', spans: [{ start: 11, end: 18, rect }] });
  assert.equal(merged.text, '中国石化招聘考试\nOriginal 4827\n图片中的新题目');
  assert.equal(merged.spans.length, 2);
  assert.equal(merged.text.slice(merged.spans[1].start, merged.spans[1].end), '图片中的新题目');
});

test('pausing extraction stops between units', async t => {
  const { dir } = await temporary(t);
  let stopped = false;
  const parser = createDocumentParser({ cacheDir: dir, ocrDataDir, shouldStop: () => stopped });
  t.after(() => parser.dispose());
  const file = path.join(dir, 'pause.doc'); await writeFile(file, '{\\rtf1 First\\par Second}');
  const iterator = parser.extract(file, 'word', 'pause');
  assert.equal((await iterator.next()).value.text, 'First');
  stopped = true;
  await assert.rejects(iterator.next(), ParserStoppedError);
});

test('bundled offline OCR returns searchable text with image coordinates', async t => {
  try { await access(path.join(ocrDataDir, 'chi_sim.traineddata')); await access(path.join(ocrDataDir, 'eng.traineddata')); }
  catch { t.skip('OCR model resources have not been fetched'); return; }
  const { dir, parser } = await temporary(t);
  const canvas = createCanvas(1200, 300); const context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 300);
  context.fillStyle = 'black'; context.font = 'bold 58px FixtureCJK';
  context.fillText('MATERIAL SEARCH 4827', 35, 110);
  context.font = '50px FixtureCJK';
  context.fillText('中文资料离线搜索验证示例', 35, 220);
  const file = path.join(dir, 'ocr.png'); await writeFile(file, await canvas.encode('png'));
  const [unit] = await Array.fromAsync(parser.extract(file, 'image', 'ocr-fixture'));
  const result = await parser.recognize(file, unit);
  assert.match(result.text, /4827/);
  assert.ok((result.text.match(/[\u4e00-\u9fff]/g) ?? []).length >= 8, 'Chinese traineddata must actually recognize Chinese text');
  assert.equal(result.needsOcr, false);
  assert.ok(result.spans.length > 0);
  assert.ok(result.spans.every(span => span.start >= 0 && span.end <= result.text.length && span.rect.width > 0));
});

test('PDF OCR renders image operators with the same native canvas runtime', async t => {
  try { await access(path.join(ocrDataDir, 'chi_sim.traineddata')); await access(path.join(ocrDataDir, 'eng.traineddata')); }
  catch { t.skip('OCR model resources have not been fetched'); return; }
  const { dir, parser } = await temporary(t);
  const file = path.join(dir, 'mixed-ocr.pdf'); await writeFile(file, pdfFixture(true));
  const [unit] = await Array.fromAsync(parser.extract(file, 'pdf', 'mixed-pdf-ocr'));
  const recognized = await parser.recognize(file, unit);
  assert.equal(recognized.needsOcr, false);
  assert.ok(recognized.text.includes(unit.text.trim()), 'native text must survive the OCR pass');
  assert.ok(recognized.spans.length > 0);
});

test('PDF OCR invalidates cached documents when the same file path gets new content', async t => {
  try { await access(path.join(ocrDataDir, 'chi_sim.traineddata')); await access(path.join(ocrDataDir, 'eng.traineddata')); }
  catch { t.skip('OCR model resources have not been fetched'); return; }
  const { dir, parser } = await temporary(t);
  for (const useStoredHash of [false, true]) {
    const file = path.join(dir, `replace-${useStoredHash}.pdf`);
    const unit = { key: 'pdf:1', ordinal: 0, locator: { type: 'pdf' as const, page: 1 }, text: '', spans: [], needsOcr: true };
    await writeFile(file, pdfFixture(false, 'FIRST CACHE 11111'));
    const first = await parser.recognize(file, useStoredHash ? { ...unit, id: 1, contentHash: 'first-hash' } : unit);
    assert.match(first.text, /11111/);
    await writeFile(file, pdfFixture(false, 'OTHER CACHE 99999'));
    const second = await parser.recognize(file, useStoredHash ? { ...unit, id: 1, contentHash: 'second-hash' } : unit);
    assert.match(second.text, /99999/);
    assert.doesNotMatch(second.text, /11111/);
  }
});

test('PDF image-region geometry follows graphics transforms and safely rejects uncertain operators', () => {
  const ops = { save: 1, transform: 2, paintImageXObject: 3, restore: 4, paintFormXObjectBegin: 5,
    paintFormXObjectEnd: 6, paintImageXObjectRepeat: 7, beginGroup: 8 };
  const viewport = { transform: [1, 0, 0, -1, 0, 200], width: 200, height: 200 };
  const regions = pdfImageRegions({ fnArray: [1, 2, 5, 3, 6, 4],
    argsArray: [null, [100, 0, 0, 50, 30, 40], [new Float32Array([1, 0, 0, 1, 0, 0]), null], null, [], null] }, ops, viewport, 0);
  assert.deepEqual(regions, [{ x: 0.15, y: 0.55, width: 0.5, height: 0.25 }]);
  assert.equal(pdfImageRegions({ fnArray: [7], argsArray: [[]] }, ops, viewport), null);
  assert.equal(pdfImageRegions({ fnArray: [8], argsArray: [{}] }, ops, viewport), null);
  assert.equal(pdfImageRegions({ fnArray: [4], argsArray: [null] }, ops, viewport), null);
  const [mapped] = translateCropSpans([{ start: 0, end: 4, rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }], regions![0]);
  assert.deepEqual(mapped, { start: 0, end: 4, rect: { x: 0.25, y: 0.6000000000000001, width: 0.2, height: 0.1 } });
});

test('PDF image-region OCR finds raster text and maps its highlights back to the page', async t => {
  try { await access(path.join(ocrDataDir, 'chi_sim.traineddata')); await access(path.join(ocrDataDir, 'eng.traineddata')); }
  catch { t.skip('OCR model resources have not been fetched'); return; }
  const { dir, parser } = await temporary(t);
  const canvas = createCanvas(600, 140), context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 600, 140);
  context.fillStyle = 'black'; context.font = 'bold 42px FixtureCJK'; context.fillText('RASTER SECRET 6824', 15, 85);
  const pixels = context.getImageData(0, 0, 600, 140).data;
  const rgb = Buffer.alloc(600 * 140 * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) { rgb[j] = pixels[i]; rgb[j + 1] = pixels[i + 1]; rgb[j + 2] = pixels[i + 2]; }
  const file = path.join(dir, 'raster-question.pdf');
  await writeFile(file, pdfFixture(true, undefined, { width: 600, height: 140, hex: rgb.toString('hex') }));
  const [unit] = await Array.fromAsync(parser.extract(file, 'pdf', 'raster-region'));
  const result = await parser.recognize(file, unit);
  assert.ok(result.text.includes(unit.text.trim()));
  assert.match(result.text, /6824/);
  const at = result.text.indexOf('6824');
  const span = result.spans.find(s => s.start <= at && s.end > at);
  assert.ok(span && span.rect.y > 0.55 && span.rect.y < 0.9, 'image OCR coordinates must be relative to the whole PDF page');
});
