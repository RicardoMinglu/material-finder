import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@napi-rs/canvas-win32-x64-msvc';
const require = createRequire(import.meta.url);
// PDF.js may carry a second Canvas version nested in its own node_modules.
const canvasManifests = [...new Set([
  require.resolve('@napi-rs/canvas/package.json'),
  createRequire(require.resolve('pdfjs-dist/package.json')).resolve('@napi-rs/canvas/package.json'),
])];
const runtimes = [];
for (const manifest of canvasManifests) {
  const canvas = JSON.parse(await readFile(manifest, 'utf8'));
  if (canvas.optionalDependencies?.[packageName] !== canvas.version) {
    throw new Error(`Canvas ${canvas.version} does not declare the matching Windows x64 runtime.`);
  }
  runtimes.push({
    version: canvas.version,
    target: path.join(path.dirname(path.dirname(manifest)), 'canvas-win32-x64-msvc'),
  });
}

async function verifyNative(directory, version) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== packageName || metadata.version !== version) {
    throw new Error(`Expected ${packageName}@${version}, found ${metadata.name}@${metadata.version}.`);
  }
  const binaryName = metadata.main;
  if (typeof binaryName !== 'string' || path.basename(binaryName) !== binaryName || !binaryName.endsWith('.node')) {
    throw new Error('Unexpected native runtime entry point.');
  }
  const binary = await readFile(path.join(directory, binaryName));
  const peOffset = binary.length >= 64 ? binary.readUInt32LE(0x3c) : 0;
  if (binary.toString('ascii', 0, 2) !== 'MZ' || peOffset + 6 > binary.length ||
      binary.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' || binary.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error(`${binaryName} is not a Windows x64 PE binary.`);
  }
  return { binaryName, bytes: binary.length };
}

const verifyIndex = process.argv.indexOf('--verify-packaged');
if (verifyIndex !== -1) {
  const argument = process.argv[verifyIndex + 1];
  if (!argument) throw new Error('Usage: node scripts/prepare-win-runtime.mjs --verify-packaged release/win-unpacked');
  const appDir = path.resolve(argument);
  const unpacked = path.join(appDir, 'resources/app.asar.unpacked');
  for (const runtime of runtimes) {
    const relative = path.relative(project, runtime.target);
    const result = await verifyNative(path.join(unpacked, relative), runtime.version);
    console.log(`Verified packaged Windows x64 canvas ${runtime.version} (${result.bytes} bytes): ${relative}`);
  }
  for (const language of ['chi_sim', 'eng']) {
    const model = await readFile(path.join(appDir, 'resources/ocr', `${language}.traineddata`));
    if (!model.length) throw new Error(`The ${language} OCR model is empty.`);
  }
  await access(path.join(unpacked, 'node_modules/tesseract.js/src/worker-script/node/index.js'));
  const cores = await readdir(path.join(unpacked, 'node_modules/tesseract.js-core'));
  if (!cores.some(file => file.endsWith('.wasm'))) throw new Error('OCR WASM runtime is missing from the package.');
  await access(path.join(appDir, 'resources/app.asar'));
  for (const file of ['cmaps/Adobe-GB1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm']) {
    const bytes = await readFile(path.join(unpacked, 'node_modules/pdfjs-dist', file));
    if (!bytes.length) throw new Error(`PDF.js resource is empty: ${file}`);
  }
  console.log('Verified packaged OCR worker, WASM, both models and application archive.');
  console.log('Verified unpacked PDF.js CMap, font and image-decoder resources.');
  process.exit(0);
}

async function fetchChecked(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return response;
}

async function prepareRuntime({ target, version }) {
  try {
    const result = await verifyNative(target, version);
    console.log(`Windows x64 canvas ${version} is already prepared (${result.bytes} bytes).`);
    return;
  } catch (error) {
    if (process.argv.includes('--check')) throw error;
  }

  // Fetch only the exact optional package. npm install --force can prune the host
  // canvas binary or rewrite package-lock.json, breaking the following Mac build.
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const metadata = await (await fetchChecked(metadataUrl)).json();
  if (metadata.name !== packageName || metadata.version !== version) throw new Error('Registry package identity mismatch.');
  const tarballUrl = new URL(metadata.dist.tarball);
  if (tarballUrl.protocol !== 'https:' || tarballUrl.hostname !== 'registry.npmjs.org') {
    throw new Error('Native runtime tarball must come from the official npm registry.');
  }
  const archive = Buffer.from(await (await fetchChecked(tarballUrl.href)).arrayBuffer());
  const sri = String(metadata.dist.integrity).split(/\s+/).find(entry => entry.startsWith('sha512-'));
  if (!sri) throw new Error('Registry did not provide SHA-512 package integrity.');
  const expected = Buffer.from(sri.slice('sha512-'.length), 'base64');
  const actual = createHash('sha512').update(archive).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Native package integrity verification failed.');

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'material-finder-win-runtime-'));
  const staging = await mkdtemp(path.join(path.dirname(target), '.canvas-win-x64-'));
  let installed = false;
  try {
    const tarball = path.join(temporary, 'runtime.tgz');
    await writeFile(tarball, archive);
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/);
    if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..') || entry.includes('\\'))) {
      throw new Error('Unexpected tar archive path.');
    }
    const verboseEntries = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/);
    if (verboseEntries.some(entry => !entry.startsWith('-') && !entry.startsWith('d'))) {
      throw new Error('Native runtime archive must not contain symlinks or special files.');
    }
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', staging], { stdio: 'pipe' });
    const result = await verifyNative(staging, version);
    await mkdir(path.dirname(target), { recursive: true });
    // Only this generated Windows dependency is replaced; all host dependencies remain.
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    installed = true;
    console.log(`Prepared ${packageName}@${version} (${result.bytes} bytes). Host canvas runtime and package-lock.json are unchanged.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (!installed) await rm(staging, { recursive: true, force: true });
  }
}

for (const runtime of runtimes) await prepareRuntime(runtime);
