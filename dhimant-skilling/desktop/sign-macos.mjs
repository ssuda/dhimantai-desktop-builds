import {pathToFileURL} from 'node:url';
import {join, basename, resolve} from 'node:path';

export function signingOptions(source, app, mode, env = process.env) {
  if (!['developer-id', 'ad-hoc'].includes(mode)) throw new Error('Select an explicit macOS signing mode');
  const release = mode === 'developer-id';
  if (release && (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID || '') ||
      !env.MACOS_SIGNING_IDENTITY?.startsWith('Developer ID Application: ') ||
      !env.MACOS_SIGNING_IDENTITY.endsWith(` (${env.APPLE_TEAM_ID})`))) {
    throw new Error('A Developer ID Application identity and matching APPLE_TEAM_ID are required');
  }
  return {app, platform: 'darwin', type: 'distribution',
    identity: release ? env.MACOS_SIGNING_IDENTITY : '-', identityValidation: release,
    ...(release && env.MACOS_SIGNING_KEYCHAIN ? {keychain: env.MACOS_SIGNING_KEYCHAIN} : {}),
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    strictVerify: true,
    optionsForFile: file => {
      const name = basename(file);
      const type = name.includes('Helper (GPU)') ? 'helper-gpu' : name.includes('Helper (Renderer)') ? 'helper-renderer'
        : name.includes('Helper (Plugin)') ? 'helper-plugin' : name.includes('Helper') ? 'helper' : 'app';
      return {hardenedRuntime: release,
        // Pinned osx-sign adds --timestamp for undefined (Apple's default server).
        // Ad-hoc previews have no Developer ID team and can be signed offline.
        timestamp: release ? undefined : 'none',
        additionalArguments: release ? [] : ['--options', '0'],
        entitlements: join(source, 'build/azure-pipelines/darwin', type + '-entitlements.plist')};
    }};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, app, mode] = process.argv.slice(2);
  const options = signingOptions(source, app, mode);
  const {sign} = await import(pathToFileURL(join(source, 'build/node_modules/@electron/osx-sign/dist/index.js')));
  await sign(options);
}
