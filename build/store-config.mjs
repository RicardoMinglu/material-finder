import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const metadata = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
export const output = path.join(project, 'release/store');
export const applicationId = 'MaterialFinder';
// A compatibility floor, not a claim that this OS has passed desktop QA.
export const minVersion = '10.0.19041.0';
const fields = {
  identityName: 'MATERIAL_FINDER_STORE_IDENTITY_NAME',
  publisher: 'MATERIAL_FINDER_STORE_PUBLISHER',
  publisherDisplayName: 'MATERIAL_FINDER_STORE_PUBLISHER_DISPLAY_NAME',
};

export function storeVersion(version = metadata.version) {
  if (!/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      version.split('.').some(part => Number(part) > 65535)) {
    throw new Error('Store version must be major.minor.patch (major 1..65535; minor/patch 0..65535), without prerelease/build metadata.');
  }
  return `${version}.0`;
}

export function readIdentity(env) {
  // Version only the public product identity. If any environment override is
  // present, require all three so different products cannot be mixed together.
  if (env === undefined) {
    env = process.env;
    if (!Object.values(fields).some(key => env[key] !== undefined)) {
      let configured;
      try { configured = JSON.parse(readFileSync(path.join(project, 'build/store-identity.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      env = Object.fromEntries(Object.entries(fields).map(([key, variable]) => [variable, configured?.[key]]));
    }
  }
  const missing = Object.values(fields).filter(key => typeof env[key] !== 'string' || !env[key].trim());
  if (missing.length) throw new Error(`Missing Partner Center public identity fields: ${missing.join(', ')}. See docs/microsoft-store.md. No submit-ready package can be built.`);
  const identity = Object.fromEntries(Object.entries(fields).map(([key, variable]) => [key, env[variable]]));
  for (const [key, value] of Object.entries(identity)) {
    if (value !== value.trim() || /[\x00-\x1f\x7f]|\$\{/.test(value) || /placeholder|replace[_ -]?me|your[_ -]?(publisher|company|identity)|待填写|请填写/i.test(value)) {
      throw new Error(`Invalid ${fields[key]}: use the exact Partner Center value, without placeholders or surrounding whitespace.`);
    }
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identity.identityName)) throw new Error('Package/Identity/Name must contain 3..50 ASCII letters, digits, periods or hyphens.');
  if (!/^CN=.+/.test(identity.publisher) || identity.publisher.length > 8192) throw new Error('Package/Identity/Publisher must be the complete Partner Center distinguished name beginning CN=.');
  if (identity.publisherDisplayName.length > 256) throw new Error('Package/Properties/PublisherDisplayName exceeds 256 characters.');
  return identity;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

// Render the identity as escaped XML ourselves: builder 26.15.3 interpolates
// its default template verbatim (publisher names may legitimately contain &).
export function renderManifest(identity) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap rescap">
 <Identity Name="${xml(identity.identityName)}" Publisher="${xml(identity.publisher)}" Version="${storeVersion()}" ProcessorArchitecture="x64" />
 <Properties>
  <DisplayName>资料快搜</DisplayName>
  <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
  <Description>${xml(metadata.description)}</Description>
  <Logo>assets\\StoreLogo.png</Logo>
 </Properties>
 <Resources><Resource Language="zh-CN" /></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="${minVersion}" MaxVersionTested="${minVersion}" /></Dependencies>
 <Applications>
  <Application Id="${applicationId}" Executable="app\\MaterialFinder.exe" EntryPoint="Windows.FullTrustApplication">
   <uap:VisualElements DisplayName="资料快搜" Description="${xml(metadata.description)}"
    BackgroundColor="#102A43" Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png">
    <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" />
   </uap:VisualElements>
  </Application>
 </Applications>
 <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`;
}

export function createStoreConfig(identity) {
  storeVersion();
  return {
    ...metadata.build,
    extends: null,
    directories: { output, buildResources: path.join(project, 'resources/store') },
    // Original NSIS/DMG entry points continue to use package.json build config.
    win: {
      ...metadata.build.win,
      executableName: 'MaterialFinder',
      target: [{ target: 'appx', arch: ['x64'] }],
      artifactName: 'MaterialFinder-${version}-store-${arch}.${ext}',
      requestedExecutionLevel: 'asInvoker',
      signExecutable: false,
    },
    publish: null,
    ...(identity ? { appx: {
      ...identity,
      applicationId,
      displayName: '资料快搜',
      languages: ['zh-CN'],
      minVersion,
      maxVersionTested: minVersion,
      setBuildNumber: false,
      addAutoLaunchExtension: false,
      capabilities: ['runFullTrust'],
      customManifestPath: path.join(output, 'config/AppxManifest.xml'),
    } } : {}),
  };
}
