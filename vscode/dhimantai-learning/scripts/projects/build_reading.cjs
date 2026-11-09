/* Author tooling: create an offline source bundle without fabricating upstream history. */
const {execFileSync} = require('node:child_process');
const {cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {createHash} = require('node:crypto');
const extension = resolve(__dirname, '../..'), media = join(extension, 'media/projects');
const upstream = 'https://github.com/Textualize/rich.git', tag = 'v14.3.4';
const commit = 'ee8378c3bbbd7c75abc2f55c6c19e83b218ae81d';
const temporary = mkdtempSync(join(tmpdir(), 'dhimantai-reading-'));
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8', timeout:120000,
  env:{...process.env, GIT_AUTHOR_DATE:'2026-11-08T00:00:00Z', GIT_COMMITTER_DATE:'2026-11-08T00:00:00Z'}}).trim();
const save = (cwd, message) => {
  git(cwd, 'add', '.');
  git(cwd, '-c','user.name=dhimantAI','-c','user.email=starter@dhimantai.local','-c','commit.gpgsign=false','commit','-qm',message);
};
const sources = (root, prefix = '') => readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(entry => {
  if (entry.name.startsWith('.')) return [];
  const path = prefix + entry.name;
  if (entry.isSymbolicLink()) throw new Error('Review linked source before packaging: '+path);
  return entry.isDirectory() ? sources(root,path+'/') : /\.(py|json|toml|txt)$/.test(path) ? [path] : [];
});
try {
  const upstreamDir = process.argv[2] ? resolve(process.argv[2]) : join(temporary,'upstream');
  if (!process.argv[2]) git(temporary,'clone','--depth','1','--branch',tag,upstream,upstreamDir);
  if (git(upstreamDir,'rev-parse','HEAD') !== commit) throw new Error('Unexpected Rich source revision.');
  const archive = join(temporary,'source.tar'), snapshot = join(temporary,'snapshot');
  git(upstreamDir,'archive','--format=tar','--output='+archive,commit);
  mkdirSync(snapshot);
  execFileSync('tar',['-xf',archive,'-C',snapshot],{timeout:30000});
  git(snapshot,'init','-q','-b','main');
  save(snapshot,`Snapshot of Textualize/rich ${tag} (${commit}); upstream history not included`);
  const sourceTree = git(snapshot,'rev-parse','HEAD^{tree}');
  if (sourceTree !== git(upstreamDir,'rev-parse','HEAD^{tree}')) throw new Error('Source tree changed during packaging.');
  cpSync(join(media,'rich-reading'),snapshot,{recursive:true});
  writeFileSync(join(snapshot,'.gitignore'),readFileSync(join(snapshot,'.gitignore'),'utf8')+'\n# Course-only dependency cache and secrets\n.dhimantai-local/\n.env*\n');
  save(snapshot,'Add dhimantAI code-reading guide and isolated examples');
  const bundle = join(media,'rich.bundle');
  git(snapshot,'bundle','create',bundle,'main');
  git(snapshot,'bundle','verify',bundle);
  cpSync(join(snapshot,'LICENSE'),join(media,'rich.LICENSE'));
  const files = sources(snapshot);
  writeFileSync(join(media,'rich-source.json'),JSON.stringify({upstream,tag,commit,sourceTree,
    license:'MIT',bundle_sha256:createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    python_files:files.filter(path=>path.endsWith('.py')).length,evidenceFiles:files},null,2)+'\n');
  console.log(JSON.stringify({tag,commit,pythonFiles:files.filter(path=>path.endsWith('.py')).length,bundleBytes:readFileSync(bundle).length}));
} finally { rmSync(temporary,{recursive:true,force:true}); }
