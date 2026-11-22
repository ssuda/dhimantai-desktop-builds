import { copyFile, cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const sdk = require.resolve('livekit-client');
await copyFile(sdk, new URL('../media/livekit-client.umd.js', import.meta.url));
await copyFile(resolve(dirname(sdk), '../LICENSE'), new URL('../media/livekit-client.LICENSE', import.meta.url));

const { build } = await import('esbuild');
const { fileURLToPath } = await import('node:url');
const root = fileURLToPath(new URL('../', import.meta.url));
const studio = resolve(root,'media/build-studio');
const {execFileSync} = await import('node:child_process');
execFileSync(process.platform==='win32'?'python':'python3', [resolve(root,'../../content/courses/full-stack-web/build-studio/build_starters.py'),studio]);
const courseTools = resolve(root,'media/course-extensions');
await rm(courseTools,{recursive:true,force:true});
await mkdir(courseTools,{recursive:true});
const coursesRoot = resolve(root, '../../content/courses');
for (const group of await readdir(coursesRoot, {withFileTypes: true})) {
  if (!group.isDirectory()) continue;
  const source = resolve(coursesRoot, group.name, 'editor-extensions');
  const files = await readdir(source).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of files.filter(name => name.endsWith('.vsix'))) {
    const bytes = await readFile(resolve(source, name));
    if (name !== createHash('sha256').update(bytes).digest('hex') + '.vsix')
      throw new Error('Course editor package checksum differs: ' + group.name + '/' + name);
    await writeFile(resolve(courseTools, name), bytes);
  }
}
await copyFile(resolve(root,'../../content/courses/full-stack-web/build-studio/check.py'), resolve(studio,'check.py'));
await build({entryPoints:[resolve(root,'webview/buildStudio.ts')],bundle:true,minify:true,outdir:studio,target:'es2022'});
// Instructor and desktop consume one authored business shift.
await copyFile(resolve(root, '../../agent/course_projects/data/erpnext_shift.json'), resolve(root, 'media/browser/erpnext/shift.json'));
await copyFile(resolve(root, '../../agent/course_projects/data/inference_runtime.json'), resolve(root, 'media/course/inference_runtime.json'));
await copyFile(resolve(root, '../../agent/course_projects/data/lab_compute.json'), resolve(root, 'media/course/lab_compute.json'));
await copyFile(resolve(root, '../../content/courses/inference-engineering/labs/cluster.py'), resolve(root, 'media/course/inference_cluster.py'));
await build({entryPoints: [resolve(root, 'webview/coachMarkdown.ts')], bundle: true, minify: true,
  outfile: resolve(root, 'media/coachMarkdown.js'), format: 'iife', target: 'es2022',
  assetNames: 'fonts/[name]', loader: {'.woff2': 'file', '.woff': 'file', '.ttf': 'file'}});
await mkdir(resolve(root, 'media/fonts'), {recursive: true});
for (const file of ['paper-sans.ttf', 'paper-sans-bold.ttf', 'PAPER_FONT_LICENSE.txt']) {
  await copyFile(resolve(root, '../../assets/fonts', file), resolve(root, 'media/fonts', file));
}
await copyFile(resolve(root, 'node_modules/pdfmake/LICENSE'), resolve(root, 'media/fonts/pdfmake.LICENSE'));
const outdir = resolve(root, 'media/learning-room');
await build({entryPoints:[resolve(root,'webview/composer.ts'),resolve(root,'webview/composer.css')], bundle:true, minify:true,
  outdir, format:'iife', globalName:'LearningComposer', target:'es2022'});
await build({entryPoints:[resolve(root, 'webview/diagramEngines.ts')], bundle:true, minify:true,
  outfile:resolve(outdir, 'diagramEngines.js'), format:'iife', globalName:'DhimantDiagrams',
  footer:{js:'globalThis.DhimantDiagrams = DhimantDiagrams;'}, target:'es2022', legalComments:'eof'});
await copyFile(resolve(root, 'node_modules/mermaid/LICENSE'), resolve(outdir, 'mermaid.LICENSE'));
await copyFile(resolve(root, 'webview/diagramEngines.LICENSE'), resolve(outdir, 'diagramEngines.LICENSE'));
await build({entryPoints: [resolve(root, 'webview/audioControls.ts')], bundle: true, minify: true,
  outfile: resolve(outdir, 'audioControls.js'), format: 'iife', globalName: 'DhimantAudio',
  footer: {js: 'globalThis.DhimantAudio = DhimantAudio;'}, target: 'es2022'});
await build({
  entryPoints: [resolve(root, 'webview/room.ts'), resolve(root, 'webview/learningWorkspace.ts'), resolve(root, 'webview/courseNotes.ts')], bundle: true, minify: true,
  outdir, target: 'es2022', assetNames: 'fonts/[name]', legalComments: 'eof',
  loader: {'.woff2': 'file', '.woff': 'file', '.ttf': 'file'},
});
for (const [name, source] of [['markdown-it','markdown-it/LICENSE'], ['katex','katex/LICENSE'],
    ['markdown-it-katex','@vscode/markdown-it-katex/LICENSE']]) {
  await copyFile(resolve(root, 'node_modules', source), resolve(outdir, name + '.LICENSE'));
}

// Build the seven course notebooks from the same authored Markdown used by the Colab exporter.
// Reuse Flutter's ebook engine and bridge; never maintain a second reader fork.
const study = resolve(root, 'media/study');
await mkdir(study, {recursive:true});
const pdf = resolve(root,'node_modules/pdfjs-dist');
await mkdir(resolve(study,'pdf'),{recursive:true});
for (const file of ['cmaps','standard_fonts','wasm','LICENSE']) await cp(resolve(pdf,file),resolve(study,'pdf',file),{recursive:true});
await copyFile(resolve(pdf,'legacy/build/pdf.worker.min.mjs'),resolve(study,'pdf/pdf.worker.min.mjs'));
for (const file of ['epub.min.js', 'jszip.min.js', 'reader_bridge.js', 'epub.LICENSE', 'jszip.LICENSE', 'pako.LICENSE']) {
  await copyFile(resolve(root, '../../assets/epub_reader', file), resolve(study, file));
}
await copyFile(resolve(root, '../../agent/course_projects/data/book_companions.json'), resolve(study, 'book_companions.json'));
await build({entryPoints:[resolve(root, 'webview/study.ts')], bundle:true, minify:true,
  outdir:study, target:'es2022', assetNames:'fonts/[name]', legalComments:'eof',
  loader:{'.woff2':'file','.woff':'file','.ttf':'file'}});
// EPUB iframes must not wait for another VS Code resource request on every chapter.
// Embed the math stylesheet and WOFF2 fonts in the transient book. The supported
// Chromium runtime understands WOFF2, so no duplicate fallback font bytes are needed.
const katexDirectory = dirname(require.resolve('katex/dist/katex.min.css'));
let readerCss = await readFile(resolve(katexDirectory, 'katex.min.css'), 'utf8');
for (const source of [...readerCss.matchAll(/src:([^;}]+)/g)]) {
  const font = source[1].match(/url\((?:["'])?(fonts\/[A-Za-z0-9_-]+\.woff2)(?:["'])?\)/);
  if (!font) throw new Error('Study font source has no WOFF2 asset');
  const bytes = await readFile(resolve(katexDirectory, font[1]));
  readerCss = readerCss.replace(source[0], `src:url("data:font/woff2;base64,${bytes.toString('base64')}") format("woff2")`);
}
await writeFile(resolve(study, 'reader.css'), readerCss);
const editorPackages = ['codemirror', 'style-mod', 'w3c-keyname', 'crelt'];
for (const scope of ['@codemirror', '@lezer']) {
  for (const name of await readdir(resolve(root, 'node_modules', scope))) editorPackages.push(scope + '/' + name);
}
await writeFile(resolve(outdir, 'editor-licenses.txt'), (await Promise.all(editorPackages.map(async name =>
  name + '\n\n' + await readFile(resolve(root, 'node_modules', name, 'LICENSE'), 'utf8')))).join('\n\n'));
const lessons = resolve(root, '../../content/courses/build-an-llm-from-scratch');
const labs = resolve(root, 'media/course/labs');
const computeCatalog=JSON.parse(await readFile(resolve(root,'media/course/lab_compute.json'),'utf8'));
const llmCompute={version:1,status:'specified',...computeCatalog.courses['build an llm from scratch'].default,cloud:computeCatalog.cloud};
await mkdir(labs, {recursive:true});
for (const file of (await readdir(lessons)).filter(n => /^\d\d-.*\.md$/.test(n)).sort()) {
  const source = await readFile(resolve(lessons,file),'utf8');
  const cells = source.split(/^```python\r?\n([\s\S]*?)^```[ \t]*$/gm)
    .map((s,i) => ({id:'part-'+i, cell_type:i%2?'code':'markdown', source:s.trim(), metadata:{},
      ...(i%2?{execution_count:null,outputs:[]}:{})})).filter(c=>c.source);
  cells.push({id:'practice',cell_type:'code',source:'# Try the practice tasks here.\n',metadata:{},execution_count:null,outputs:[]});
  cells.unshift({id:'compute-requirements',cell_type:'markdown',metadata:{},source:'**Lab compute: 0 GPUs · CPU lab.** '+llmCompute.note+' Compute, storage and network charges are separate from the course fee.'});
  await writeFile(resolve(labs,file.replace(/\.md$/,'.ipynb')),JSON.stringify({nbformat:4,nbformat_minor:5,
    metadata:{dhimantai_compute:llmCompute,kernelspec:{name:'python3',display_name:'Python (CPU lab)',language:'python'},language_info:{name:'python'}},cells},null,2));
}
await build({entryPoints:[resolve(root,'scripts/course-runner.ts')],outfile:resolve(root,'media/course/runner.cjs'),
  platform:'node',bundle:true,target:'node22'});
