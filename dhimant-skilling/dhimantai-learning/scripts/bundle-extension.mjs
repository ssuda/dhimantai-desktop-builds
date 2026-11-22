import { build } from 'esbuild';

// Bundle the type-checked CommonJS output so the host and authoring CLI keep
// their existing entry points and __dirname-relative media paths in the VSIX.
await build({
  entryPoints: ['out/src/extension.js', 'out/src/apps/cli.js'],
  outdir: 'out/src',
  outbase: 'out/src',
  allowOverwrite: true,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', './out/vendor/*'],
});
