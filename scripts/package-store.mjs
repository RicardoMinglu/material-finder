import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, Platform, Arch } from 'electron-builder';
import { project, output, readIdentity, storeVersion, renderManifest, createStoreConfig } from '../build/store-config.mjs';
import { generateStoreAssets } from './generate-store-assets.mjs';
import { verifyStoreDirectory, verifyStorePackage } from './verify-store-package.mjs';
import { prepareMacStoreSdk } from './store-native-sdk.mjs';

let macStoreSdk;

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--dir'].includes(arg)) || args.length > 1) throw new Error('Usage: node scripts/package-store.mjs [--check | --dir]');
  const directoryOnly = args.includes('--dir');
  // Fail before downloads/building; directory-only preparation needs no identity.
  let identity;
  try { identity = readIdentity(); }
  catch (error) {
    if (!directoryOnly || !error.message.startsWith('Missing Partner Center')) throw error;
  }
  storeVersion();
  if (args.includes('--check')) {
    console.log(`Identity syntax and version ${storeVersion()} passed: ${JSON.stringify(identity)}. No online association was verified.`);
    process.exit(0);
  }
  if (!directoryOnly && !['win32', 'darwin'].includes(process.platform)) throw new Error('Store packaging supports Windows or macOS with the pinned Microsoft SDK.');
  process.chdir(project);
  // Avoid automatic certificate discovery. Store signs after certification.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  if (process.env.CSC_LINK || process.env.WIN_CSC_LINK) throw new Error('Unset CSC_LINK/WIN_CSC_LINK for the unsigned Store build; this command never consumes signing credentials.');
  if (!directoryOnly && process.platform === 'darwin') macStoreSdk = await prepareMacStoreSdk();
  for (const script of ['fetch-ocr.mjs', 'prepare-win-runtime.mjs', 'build.mjs']) {
    const result = spawnSync(process.execPath, [path.join(project, 'scripts', script)], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${script} failed (${result.status ?? result.error?.message}).`);
  }
  await generateStoreAssets();
  if (identity) {
    await mkdir(path.join(output, 'config'), { recursive: true });
    await writeFile(path.join(output, 'config/AppxManifest.xml'), renderManifest(identity));
  }
  const config = createStoreConfig(identity);
  const artifacts = await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget(directoryOnly || macStoreSdk ? 'dir' : 'appx', Arch.x64),
    config,
    publish: 'never',
  });
  await verifyStoreDirectory(path.join(output, 'win-unpacked'));
  await writeFile(path.join(output, 'directory-verification.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(), hostPlatform: process.platform,
    target: 'win32-x64', version: storeVersion(), identity: identity ?? null,
    checked: ['x64 PE and native dependencies', 'app archive allowlist', 'PDF.js resources', 'OCR worker/WASM/model hashes'],
    manifestPrepared: Boolean(identity),
    notChecked: ['Windows installation and runtime', 'WACK', 'Partner Center association/certification'],
    submitReadyPackage: false,
  }, null, 2) + '\n');
  if (directoryOnly) {
    console.log('Prepared release/store/win-unpacked. NOT an AppX; no online Store identity association or Windows runtime test has been performed.');
  } else {
    const appx = macStoreSdk
      ? await macStoreSdk.pack(path.join(output, 'win-unpacked'), path.join(output, 'config/AppxManifest.xml'), path.join(project, 'resources/store/appx'), path.join(output, `MaterialFinder-${storeVersion().split('.').slice(0, 3).join('.')}-store-x64.appx`))
      : artifacts.find(file => file.endsWith('.appx'));
    if (!appx) throw new Error('Builder returned no AppX artifact.');
    await verifyStorePackage(appx, identity);
    if (macStoreSdk) await macStoreSdk.verifySdkPackage(appx);
    console.log(`Unsigned Store AppX built and contents checked: ${appx}. Windows installation and WACK acceptance remain required.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
if (process.exitCode) process.exit(process.exitCode);
