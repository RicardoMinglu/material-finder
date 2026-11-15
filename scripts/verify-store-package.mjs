import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { applicationId, metadata, minVersion, project, readIdentity, storeVersion } from '../build/store-config.mjs';
import { storeAssets } from './generate-store-assets.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const yauzl = require('yauzl');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });

// OPC ZIP part names are URI-encoded by Microsoft's cross-platform writer.
// Decode once (e.g. %40napi-rs), then apply the same path/root checks.
export function packageEntryPath(rawName) {
  const name = decodeURIComponent(rawName);
  assert.ok(!/[^\x20-\x7e]/.test(name) && !name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..') && !name.includes(':'), `Unsafe/non-ASCII AppX path: ${rawName}`);
  assert.ok(!name.endsWith('/'), 'Unexpected directory entry in SDK output');
  assert.ok(name.startsWith('app/') || /^assets\/[A-Za-z0-9.-]+\.png$/.test(name) || /^(?:AppxManifest\.xml|AppxBlockMap\.xml|AppxSignature\.p7x|\[Content_Types\]\.xml|resources\.pri)$/.test(name), `Unexpected package root: ${name}`);
  return name;
}

export async function verifyBlockMap(directory) {
  const text = await readFile(path.join(directory, 'AppxBlockMap.xml'), 'utf8');
  assert.equal(XMLValidator.validate(text), true, 'Malformed AppxBlockMap.xml');
  const map = parser.parse(text).BlockMap;
  assert.equal(map['@_xmlns'], 'http://schemas.microsoft.com/appx/2010/blockmap');
  assert.equal(map['@_HashMethod'], 'http://www.w3.org/2001/04/xmlenc#sha256');
  const files = Array.isArray(map.File) ? map.File : [map.File];
  const covered = new Set();
  let totalBlocks = 0;
  for (const file of files) {
    const name = packageEntryPath(file['@_Name'].replaceAll('\\', '/'));
    assert.ok(!covered.has(name), `Duplicate block-map file: ${name}`);
    covered.add(name);
    const handle = await open(path.join(directory, name), 'r');
    try {
      const info = await handle.stat();
      const size = Number(file['@_Size']);
      assert.equal(info.size, size, `Block-map file size mismatch: ${name}`);
      const blocks = file.Block === undefined ? [] : Array.isArray(file.Block) ? file.Block : [file.Block];
      assert.ok(blocks.length === Math.ceil(size / 65536) || (size === 0 && blocks.length === 1), `Block count mismatch: ${name}`);
      for (let i = 0; i < blocks.length; i++) {
        const buffer = Buffer.alloc(Math.min(65536, Math.max(0, size - i * 65536)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, i * 65536);
        assert.equal(bytesRead, buffer.length, `Short block read: ${name}`);
        assert.equal(createHash('sha256').update(buffer).digest('base64'), blocks[i]['@_Hash'], `Block-map SHA-256 mismatch: ${name} block ${i}`);
        totalBlocks++;
      }
    } finally { await handle.close(); }
  }
  const footprints = new Set(['AppxBlockMap.xml', 'AppxSignature.p7x', '[Content_Types].xml']);
  const walk = async relative => {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (!footprints.has(file)) assert.ok(covered.has(file), `File missing from block map: ${file}`);
    }
  };
  await walk('');
  console.log(`Verified SHA-256 for ${totalBlocks} AppX blocks across ${covered.size} files.`);
  return { files: covered.size, blocks: totalBlocks, algorithm: 'SHA-256' };
}

export function verifyManifest(text, identity) {
  assert.equal(XMLValidator.validate(text), true, 'Malformed AppxManifest.xml');
  const manifest = parser.parse(text).Package;
  assert.equal(manifest['@_xmlns'], 'http://schemas.microsoft.com/appx/manifest/foundation/windows10');
  assert.equal(manifest['@_xmlns:rescap'], 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities');
  for (const [key, value] of Object.entries({ Name: identity.identityName, Publisher: identity.publisher, Version: storeVersion(), ProcessorArchitecture: 'x64' })) {
    assert.equal(manifest.Identity[`@_${key}`], value, `Manifest Identity/${key}`);
  }
  assert.equal(manifest.Properties.DisplayName, metadata.productName);
  assert.equal(manifest.Properties.PublisherDisplayName, identity.publisherDisplayName);
  assert.equal(manifest.Properties.Logo, 'assets\\StoreLogo.png');
  assert.equal(manifest.Resources.Resource['@_Language'], 'zh-CN');
  const family = manifest.Dependencies.TargetDeviceFamily;
  assert.equal(family['@_Name'], 'Windows.Desktop');
  assert.equal(family['@_MinVersion'], minVersion);
  assert.equal(family['@_MaxVersionTested'], minVersion);
  const app = manifest.Applications.Application;
  assert.equal(app['@_Id'], applicationId);
  assert.equal(app['@_Executable'], 'app\\MaterialFinder.exe');
  assert.equal(app['@_EntryPoint'], 'Windows.FullTrustApplication');
  assert.deepEqual(manifest.Capabilities, { 'rescap:Capability': { '@_Name': 'runFullTrust' } });
  assert.equal(app.Extensions, undefined, 'No startup, elevation or system extensions');
  return manifest;
}

async function compareFile(packaged, original) {
  const [actual, expected] = await Promise.all([readFile(packaged), readFile(original)]);
  assert.ok(actual.length > 0, `Empty resource: ${packaged}`);
  assert.equal(sha256(actual), sha256(expected), `Resource mismatch: ${packaged}`);
}

export async function verifyStoreDirectory(directory) {
  directory = path.resolve(directory);
  execFileSync(process.execPath, [path.join(project, 'scripts/prepare-win-runtime.mjs'), '--verify-packaged', directory], { cwd: project, stdio: 'inherit' });
  const executable = await readFile(path.join(directory, 'MaterialFinder.exe'));
  assert.equal(executable.toString('ascii', 0, 2), 'MZ');
  assert.equal(executable.readUInt16LE(executable.readUInt32LE(0x3c) + 4), 0x8664, 'App executable must be Windows x64');
  const archive = path.join(directory, 'resources/app.asar');
  const files = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
  const allowedRoots = new Set(['dist', 'node_modules', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']);
  for (const file of files) {
    assert.ok(allowedRoots.has(file.split('/')[0]), `Unexpected application archive path: ${file}`);
    assert.ok(!/\.(?:sqlite(?:3)?(?:-wal|-shm)?|traineddata\.gz|pfx|p12|pem|key)$/i.test(file), `Unexpected private/data file: ${file}`);
  }
  for (const file of ['dist/main/main.js', 'dist/main/preload.cjs', 'dist/main/index-worker.js', 'dist/main/query-worker.js', 'dist/renderer/index.html', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    assert.ok(asar.extractFile(archive, file).length > 0, `Missing application file: ${file}`);
  }
  const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(packagedMetadata.version, metadata.version);
  const main = asar.extractFile(archive, 'dist/main/main.js').toString();
  assert.ok(main.includes('process.windowsStore'), 'Store-specific userData selection must be compiled');
  assert.ok(!main.includes('node:sqlite'), 'Main process must not execute synchronous SQLite queries');
  assert.ok(asar.extractFile(archive, 'dist/main/query-worker.js').toString().includes('node:sqlite'), 'Query worker must use the bundled SQLite runtime');
  assert.ok(asar.extractFile(archive, 'dist/main/index-worker.js').toString().includes('node:sqlite'), 'Index worker must use the bundled Electron SQLite runtime');
  assert.equal(sha256(Buffer.from(main)), sha256(await readFile(path.join(project, 'dist/main/main.js'))), 'Packaged main must match this build, including its Store userData path');
  const runtime = path.join(directory, 'resources/app.asar.unpacked/node_modules');
  for (const packageName of ['pdfjs-dist', 'tesseract.js-core']) {
    const resourceRoot = path.join(project, 'node_modules', packageName);
    const walk = async relative => {
      for (const entry of await readdir(path.join(resourceRoot, relative), { withFileTypes: true })) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) {
          if (packageName === 'pdfjs-dist' && !['cmaps', 'standard_fonts', 'wasm', 'build', 'legacy'].includes(file.split(path.sep)[0])) continue;
          await walk(file);
        } else if (/\.(?:wasm|bcmap|ttf|pfb)$/.test(file) || /tesseract-core.*\.wasm\.js$/.test(file) || /pdf\.worker.*\.mjs$/.test(file)) {
          await compareFile(path.join(runtime, packageName, file), path.join(resourceRoot, file));
        }
      }
    };
    await walk('');
  }
  assert.ok(files.some(file => /^dist\/renderer\/assets\/pdf\.worker.*\.mjs$/.test(file)), 'Renderer PDF worker is missing');
  for (const file of ['cmaps/Adobe-GB1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm']) {
    assert.equal(sha256(asar.extractFile(archive, `dist/renderer/pdfjs/${file}`)), sha256(await readFile(path.join(project, 'node_modules/pdfjs-dist', file))));
  }
  const models = JSON.parse(await readFile(path.join(project, 'resources/ocr/models.json'), 'utf8'));
  for (const language of ['chi_sim', 'eng']) {
    const data = await readFile(path.join(directory, 'resources/ocr', `${language}.traineddata`));
    assert.equal(data.length, models[language].bytes);
    assert.equal(sha256(data), models[language].sha256, `${language} OCR model hash`);
  }
  console.log('Store directory verified: x64 executable, all resolved native Canvas packages, node:sqlite imports, app archive allowlist, PDF.js resources, OCR workers/WASM and model hashes. SQLite execution still requires Windows QA.');
}

async function extractPackage(filename, directory) {
  // Stream entries: Electron packages are large. Reject escaping or duplicate paths.
  const zip = await new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result)));
  const seen = new Set();
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      (async () => {
        const name = packageEntryPath(entry.fileName);
        assert.ok(!seen.has(name.toLowerCase()), `Duplicate AppX entry: ${name}`);
        seen.add(name.toLowerCase());
        const destination = path.join(directory, name);
        await mkdir(path.dirname(destination), { recursive: true });
        const stream = await new Promise((res, rej) => zip.openReadStream(entry, (err, data) => err ? rej(err) : res(data)));
        await pipeline(stream, createWriteStream(destination, { flags: 'wx' }));
        zip.readEntry();
      })().catch(error => { zip.close(); reject(error); });
    });
    zip.readEntry();
  });
}

export async function verifyStorePackage(filename, identity = readIdentity()) {
  filename = path.resolve(filename);
  assert.equal(path.extname(filename).toLowerCase(), '.appx', 'Expected an actual .appx produced by a Microsoft packaging SDK');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'material-store-verify-'));
  try {
    await extractPackage(filename, temporary);
    const manifest = await readFile(path.join(temporary, 'AppxManifest.xml'), 'utf8');
    verifyManifest(manifest, identity);
    const blockMap = await verifyBlockMap(temporary);
    for (const file of ['AppxBlockMap.xml', '[Content_Types].xml']) await access(path.join(temporary, file));
    for (const [file, [width, height]] of Object.entries(storeAssets)) {
      const bytes = await readFile(path.join(temporary, 'assets', file));
      assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), width);
      assert.equal(bytes.readUInt32BE(20), height);
      await compareFile(path.join(temporary, 'assets', file), path.join(project, 'resources/store/appx', file));
    }
    await verifyStoreDirectory(path.join(temporary, 'app'));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const digest = hash.digest('hex');
    await writeFile(`${filename}.sha256`, `${digest}  ${path.basename(filename)}\n`);
    await writeFile(`${filename}.verification.json`, JSON.stringify({
      verifiedAt: new Date().toISOString(), file: path.basename(filename), sha256: digest,
      identity, version: storeVersion(), architecture: 'x64',
      blockMap,
      checked: ['archive paths', 'manifest identity/capabilities', 'all block-map SHA-256 hashes', 'icons', 'app/resources/model hashes'],
      notChecked: ['Windows installation', 'Windows runtime/SQLite/OCR', 'WACK', 'Partner Center association/certification', 'signature validation (unsigned Store upload package)'],
    }, null, 2) + '\n');
    console.log(`AppX contents verified; checksum and verification report saved next to ${path.basename(filename)}.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--dir' && args.length === 2) await verifyStoreDirectory(args[1]);
    else if (args.length === 1) await verifyStorePackage(args[0]);
    else throw new Error('Usage: npm run store:verify -- <file.appx> OR --dir <win-unpacked directory>');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
