import {pathToFileURL} from 'node:url';
import {join, basename} from 'node:path';
const [source, app] = process.argv.slice(2);
const {sign} = await import(pathToFileURL(join(source, 'build/node_modules/@electron/osx-sign/dist/index.js')));
await sign({app, platform:'darwin', identity:'-', identityValidation:false,
  preAutoEntitlements:false, preEmbedProvisioningProfile:false,
  optionsForFile: file => {
    const name = basename(file);
    const type = name.includes('Helper (GPU)') ? 'helper-gpu' : name.includes('Helper (Renderer)') ? 'helper-renderer'
      : name.includes('Helper (Plugin)') ? 'helper-plugin' : name.includes('Helper') ? 'helper' : 'app';
    // Ad-hoc previews have no Developer ID team. Keep the Chromium sandbox;
    // remove hardened-runtime library validation that requires a matching team.
    // Customer signing must use Developer ID and hardenedRuntime:true instead.
    return {hardenedRuntime:false, additionalArguments:['--options','0'],
      entitlements:join(source, 'build/azure-pipelines/darwin', type + '-entitlements.plist')};
  }});
