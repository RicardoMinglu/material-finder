import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
// Build scripts intentionally stay executable as plain Node ESM on Windows.
// @ts-expect-error Build-only JavaScript module has no TS declaration.
import { metadata, readIdentity, storeVersion, renderManifest, createStoreConfig } from '../build/store-config.mjs';
// @ts-expect-error Build-only JavaScript module has no TS declaration.
import { verifyManifest, packageEntryPath, verifyBlockMap } from '../scripts/verify-store-package.mjs';

// AppX deliberately rejects prereleases; use a stable version fixture.
metadata.version = '1.1.0';
const environment = {
  MATERIAL_FINDER_STORE_IDENTITY_NAME: '12345.ExampleTestOnly',
  MATERIAL_FINDER_STORE_PUBLISHER: 'CN=Example & Test, O="Test", C=CN',
  MATERIAL_FINDER_STORE_PUBLISHER_DISPLAY_NAME: 'Test & <Example> "Publisher"',
};

test('SDK OPC paths decode npm scopes and reject encoded traversal or private roots', () => {
  assert.equal(packageEntryPath('app/node_modules/%40napi-rs/canvas/package.json'), 'app/node_modules/@napi-rs/canvas/package.json');
  for (const name of ['app/%2e%2e/secret', 'app/%5csecret', '%2fprivate/secret', 'private/key.pem', 'app/file%00.json']) assert.throws(() => packageEntryPath(name));
});

test('AppX block-map verification detects payload corruption across 64 KiB boundaries', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'material-blockmap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'app'));
  const payload = Buffer.alloc(70000, 37);
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('base64');
  const manifest = `<?xml version="1.0"?><BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256"><File Name="app\\file.bin" Size="70000"><Block Hash="${hash(payload.subarray(0, 65536))}"/><Block Hash="${hash(payload.subarray(65536))}"/></File></BlockMap>`;
  await writeFile(path.join(directory, 'AppxBlockMap.xml'), manifest);
  await writeFile(path.join(directory, 'app/file.bin'), payload);
  assert.deepEqual(await verifyBlockMap(directory), { files: 1, blocks: 2, algorithm: 'SHA-256' });
  payload[65537] = 1;
  await writeFile(path.join(directory, 'app/file.bin'), payload);
  await assert.rejects(verifyBlockMap(directory), /SHA-256 mismatch/);
});

test('Store packaging refuses missing or placeholder identities and invalid versions', () => {
  assert.throws(() => readIdentity({}), /Missing Partner Center/);
  assert.throws(() => readIdentity({ ...environment, MATERIAL_FINDER_STORE_PUBLISHER: 'CN=REPLACE_ME' }), /placeholders/);
  assert.throws(() => readIdentity({ ...environment, MATERIAL_FINDER_STORE_IDENTITY_NAME: ' my.app ' }), /whitespace/);
  assert.throws(() => readIdentity({ ...environment, MATERIAL_FINDER_STORE_PUBLISHER: 'CN=Test\nPublisher' }), /Invalid/);
  assert.throws(() => readIdentity({ ...environment, MATERIAL_FINDER_STORE_PUBLISHER_DISPLAY_NAME: '${publisher}' }), /Invalid/);
  for (const version of ['0.1.0', '1.0.1-beta', '1.0.1+3', '1.0.1.1', '1.65536.0']) assert.throws(() => storeVersion(version));
  assert.equal(storeVersion('1.0.1'), '1.0.1.0');
});

test('Store XML round-trips Partner Center punctuation and rejects mismatched identity or trust', () => {
  const identity = readIdentity(environment);
  const manifest = renderManifest(identity);
  verifyManifest(manifest, identity);
  assert.match(manifest, /&amp;/);
  assert.throws(() => verifyManifest(manifest, { ...identity, identityName: 'OtherProduct' }));
  assert.throws(() => verifyManifest(manifest.replace('runFullTrust', 'allowElevation'), identity));
  assert.throws(() => verifyManifest(manifest.replace('ProcessorArchitecture="x64"', 'ProcessorArchitecture="arm64"'), identity));
  const config = createStoreConfig(identity);
  assert.equal(config.win.executableName, 'MaterialFinder');
  assert.equal(config.appx.setBuildNumber, false);
  assert.ok(config.directories.output.endsWith(path.join('release','store')));
});

test('installed electron-builder AppxTarget preserves the custom identity manifest', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'material-appx-manifest-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const AppxTarget = require('app-builder-lib/out/targets/AppxTarget.js').default;
  const { Arch } = require('builder-util');
  const identity = readIdentity(environment);
  const config = createStoreConfig(identity);
  const template = path.join(temporary, 'template.xml');
  const destination = path.join(temporary, 'AppxManifest.xml');
  await writeFile(template, renderManifest(identity));
  const target = Object.create(AppxTarget.prototype);
  target.options = config.appx;
  target.packager = {
    appInfo: { productFilename: 'MaterialFinder', productName: '资料快搜' },
    config: {}, platformSpecificBuildOptions: {},
    getResource: async () => template,
  };
  await target.writeManifest(destination, Arch.x64, identity.publisher, []);
  verifyManifest(await readFile(destination, 'utf8'), identity);
  assert.equal(await readFile(destination, 'utf8'), renderManifest(identity));
});
