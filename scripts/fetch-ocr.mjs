import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const base = new URL('../resources/ocr/', import.meta.url);
await mkdir(base, { recursive: true });
const manifest = {};
for (const lang of ['chi_sim', 'eng']) {
  const packageRoot = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  const compressed = await readFile(path.join(packageRoot, '4.0.0_best_int', `${lang}.traineddata.gz`));
  const data = gunzipSync(compressed);
  await writeFile(new URL(`${lang}.traineddata`, base), data);
  manifest[lang] = { source: `@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  console.log(`${lang}: bundled ${data.length} bytes`);
}
await writeFile(new URL('models.json', base), JSON.stringify(manifest, null, 2));
