import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { project } from '../build/store-config.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
export const sdkRelease = {
  commit: '25a65f5c1690930813bcc10cdf1d59fa865f2bb1',
  archive: 'msix-sdk-25a65f5.tar.gz',
  sha256: '4f7acbdf4041c176c16dfcc5a449a74cfa5857d404853524f59fd70712c1c7fd',
  url: 'https://api.github.com/repos/microsoft/msix-packaging/tarball/25a65f5c1690930813bcc10cdf1d59fa865f2bb1',
};
const cmakeRelease = {
  version: '3.31.6',
  wheel: 'cmake-3.31.6-py3-none-macosx_10_10_universal2.whl',
  sha256: 'da9d4fd9abd571fd016ddb27da0428b10277010b23bb21e3678f8b9e96e1686e',
};
export const toolRoot = path.join(project, 'artifacts/store-toolchain');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function exists(file) { return access(file).then(() => true, () => false); }
async function logged(command, args, logName, options = {}) {
  try {
    const result = await run(command, args, { timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL', ...options });
    await writeFile(path.join(toolRoot, logName), result.stdout + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(path.join(toolRoot, logName), (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message);
    throw new Error(`Microsoft SDK step failed; see artifacts/store-toolchain/${logName}. ${(error.stdout ?? '').slice(-1800) || error.message}`);
  }
}

export async function prepareMacStoreSdk() {
  if (process.platform !== 'darwin') throw new Error('The native Store SDK adapter is macOS only.');
  await mkdir(toolRoot, { recursive: true });
  const archive = path.join(toolRoot, sdkRelease.archive);
  if (!await exists(archive)) {
    console.log('Downloading the pinned Microsoft MSIX SDK source to ignored build tools.');
    const response = await fetch(sdkRelease.url, { signal: AbortSignal.timeout(240000) });
    if (!response.ok || !response.body) throw new Error(`SDK source download failed: HTTP ${response.status}`);
    const temporary = `${archive}.download`;
    try {
      await pipeline(response.body, createWriteStream(temporary, { flags: 'wx' }));
      if (await digest(temporary) !== sdkRelease.sha256) throw new Error('Microsoft SDK source SHA-256 mismatch.');
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  if (await digest(archive) !== sdkRelease.sha256) throw new Error('Cached Microsoft SDK source SHA-256 mismatch.');
  const source = path.join(toolRoot, 'msix-sdk-source');
  if (!await exists(path.join(source, 'src/msix/pack/AppxPackageWriter.cpp'))) {
    await mkdir(source, { recursive: true });
    await logged('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', source], 'native-extract.log');
  }
  const buildDirectory = path.join(toolRoot, 'msix-sdk-build');
  const executable = path.join(buildDirectory, 'bin/makemsix');
  const library = path.join(buildDirectory, 'lib/libmsix.dylib');
  const marker = path.join(buildDirectory, 'material-finder-toolchain.json');
  const previous = await readFile(marker, 'utf8').then(JSON.parse).catch(() => undefined);
  const verified = previous?.commit === sdkRelease.commit && previous?.arch === process.arch &&
    await exists(executable) && await exists(library) &&
    previous.executableSha256 === await digest(executable) && previous.librarySha256 === await digest(library);
  if (!verified) {
    const wheel = path.join(toolRoot, cmakeRelease.wheel);
    if (!await exists(wheel)) {
      console.log(`Downloading local CMake ${cmakeRelease.version}; no global install.`);
      await logged('python3', ['-m', 'pip', 'download', '--no-deps', '--dest', toolRoot, `cmake==${cmakeRelease.version}`], 'cmake-download.log');
    }
    if (await digest(wheel) !== cmakeRelease.sha256) throw new Error('CMake wheel SHA-256 mismatch.');
    const cmakeDirectory = path.join(toolRoot, 'cmake-local');
    const cmake = path.join(cmakeDirectory, 'cmake/data/bin/cmake');
    if (!await exists(cmake)) {
      await mkdir(cmakeDirectory, { recursive: true });
      await pipeline(createReadStream(wheel), require('unzipper').Extract({ path: cmakeDirectory }));
      await chmod(cmake, 0o755);
    }
    console.log('Configuring Microsoft SDK with packaging and XML Schema validation enabled.');
    await logged(cmake, ['-S', source, '-B', buildDirectory,
      '-DCMAKE_BUILD_TYPE=Release', '-DMACOS=on',
      `-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
      `-DCMAKE_TOOLCHAIN_FILE=${path.join(source, 'cmake/macos.cmake')}`,
      '-DUSE_MSIX_SDK_ZLIB=on', '-DXML_PARSER=xerces', '-DUSE_VALIDATION_PARSER=on',
      '-DMSIX_PACK=on', '-DMSIX_SAMPLES=off', '-DMSIX_TESTS=off'], 'native-configure.log');
    console.log('Compiling native makemsix; progress is in artifacts/store-toolchain/native-build.log.');
    await logged(cmake, ['--build', buildDirectory, '--target', 'makemsix', '--parallel', '8'], 'native-build.log');
    await writeFile(marker, JSON.stringify({
      ...sdkRelease, arch: process.arch, cmake: cmakeRelease.version,
      xmlSchemaValidation: true, packaging: true,
      executableSha256: await digest(executable), librarySha256: await digest(library),
    }, null, 2) + '\n');
  }
  console.log(`Native Microsoft MSIX SDK ready (${sdkRelease.commit.slice(0, 7)}, ${process.arch}, XML Schema validation enabled).`);
  return {
    async pack(appDirectory, manifest, assetDirectory, destination) {
      const payload = await mkdtemp(path.join(toolRoot, '.payload-'));
      const pending = `${destination}.building`;
      const linkTree = async (from, to) => {
        await mkdir(to, { recursive: true });
        for (const item of await readdir(from, { withFileTypes: true })) {
          const input = path.join(from, item.name), output = path.join(to, item.name);
          if (item.isDirectory()) await linkTree(input, output);
          else if (item.isFile()) await link(input, output).catch(async error => {
            if (error.code !== 'EXDEV') throw error;
            await copyFile(input, output);
          });
          else throw new Error(`Unexpected non-regular payload file: ${input}`);
        }
      };
      try {
        await linkTree(appDirectory, path.join(payload, 'app'));
        await linkTree(assetDirectory, path.join(payload, 'assets'));
        await copyFile(manifest, path.join(payload, 'AppxManifest.xml'));
        // The official SDK's pack CLI always uses MSIX_VALIDATION_OPTION_FULL.
        await logged(executable, ['pack', '-d', payload, '-p', pending], 'native-pack.log');
        await rename(pending, destination);
        return destination;
      } finally {
        await rm(payload, { recursive: true, force: true });
        await rm(pending, { force: true });
      }
    },
    async verifySdkPackage(filename) {
      const directory = await mkdtemp(path.join(toolRoot, '.sdk-unpack-'));
      try {
        // Store upload packages are unsigned. -ss relaxes only signature
        // enforcement; manifest schemas, content and block hashes remain checked.
        await logged(executable, ['unpack', '-p', filename, '-d', directory, '-ss'], 'native-unpack.log');
      } finally { await rm(directory, { recursive: true, force: true }); }
      await writeFile(`${filename}.sdk-verification.json`, JSON.stringify({
        verifiedAt: new Date().toISOString(), host: 'macOS native', arch: process.arch,
        tool: 'Microsoft MSIX Packaging SDK', commit: sdkRelease.commit,
        sha256: await digest(filename), xmlSchemaValidation: true,
        pack: 'passed with FULL validation', unpack: 'passed; only unsigned-package signature enforcement waived',
        windowsInstallationAndWack: 'not run',
      }, null, 2) + '\n');
      console.log('Microsoft SDK pack/unpack validation passed. Windows installation and WACK remain separate.');
    },
  };
}
