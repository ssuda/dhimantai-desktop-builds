import {cp, mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
await mkdir(new URL('../out/vendor/', import.meta.url), {recursive: true});
// VSIX packaging excludes node_modules. Ship the driver, never download a browser at runtime.
await cp(new URL('../node_modules/playwright-core/', import.meta.url), new URL('../out/vendor/playwright-core/', import.meta.url), {recursive: true});
await build({stdin: {contents: 'module.exports = require("ws");', resolveDir: new URL('../', import.meta.url).pathname},
  bundle: true, platform: 'node', target: 'node20', external: ['bufferutil', 'utf-8-validate'],
  outfile: new URL('../out/vendor/ws.js', import.meta.url).pathname});
