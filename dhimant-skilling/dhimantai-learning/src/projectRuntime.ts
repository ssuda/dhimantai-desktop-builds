import { basename, join } from 'node:path';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { CourseEngine } from './courseEngine';
import type { ProjectCurriculum } from './projectCore';
import { run } from './podman';
import { COURSE_LANGUAGES } from './courseRecipe';

export interface ProjectRuntime {
  folder: string;
  mount: string;
  title: string;
  language: string;
  languages: string[];
  bundled: boolean;
  id: string;
}

export async function projectRuntime(folder: string, curriculum: ProjectCurriculum): Promise<ProjectRuntime> {
  const root = await realpath(folder);
  const language = curriculum.language ?? 'python', languages = new Set([language]);
  for (const [manifest, tool] of [['package.json','javascript'], ['tsconfig.json','typescript'], ['go.mod','go'], ['Cargo.toml','rust'],
    ['requirements.txt','python'], ['pyproject.toml','python']]) {
    if (await access(join(root, manifest)).then(() => true, () => false)) languages.add(tool);
  }
  if ([...languages].some(lang => !COURSE_LANGUAGES.includes(lang))) throw new Error('Unsupported project language.');
  // Keep the location documented in existing project guides, without mounting sibling course folders.
  const name = basename(root);
  const mount = /^[\w.-]+$/.test(name) && !name.startsWith('.') && !['runtime','Dockerfile','requirements.txt'].includes(name) ? name : 'project';
  return {id:curriculum.id, folder: root, mount, title:curriculum.title, language, languages:[...languages], bundled:curriculum.mode !== 'guided'};
}

/** Fingerprint only dependency manifests. Install them inside the verified, trusted project container. */
export async function prepareProjectDependencies(engine: CourseEngine, project: ProjectRuntime, previous?: string) {
  const hash = createHash('sha256');
  const manifests = new Set<string>();
  for (const name of ['requirements.txt','pyproject.toml','package.json','package-lock.json','npm-shrinkwrap.json','go.mod','go.sum','Cargo.toml','Cargo.lock',
    ...(project.id === 'rich-reading' ? ['reading/requirements.txt'] : [])]) {
    const path = join(project.folder,name);
    const file = await stat(path).catch((e:NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    if (!file) continue;
    if (!file.isFile() || await realpath(path) !== path || file.size > 8 * 1024 * 1024)
      throw new Error('Invalid project dependency manifest: ' + name);
    hash.update(name).update('\0').update(await readFile(path)); manifests.add(name);
  }
  const digest = hash.digest('hex');
  if (digest === previous) return digest;
  const exec = (cmd:string, args:string[], timeout=30000) => run(engine.bin, engine.execArgs(project.folder,cmd,args),timeout);
  await exec('git',['--version']);
  await exec('python',['-c','import sys; assert sys.version_info >= (3,10), "Project checks require Python 3.10 or later"']);
  if (manifests.has('requirements.txt')) {
    await exec('python',['-m','pip','install','-r','requirements.txt'],180000);
  }
  if (manifests.has('pyproject.toml')) {
    // A pyproject can also be tool configuration only. Install packages declared in the project table.
    const dependencies = await exec('python', ['-c',
      ['import json', 'try: import tomllib', 'except ImportError: from pip._vendor import tomli as tomllib',
        'with open("pyproject.toml","rb") as f: print(json.dumps(tomllib.load(f).get("project",{}).get("dependencies",[])))'].join('\n')]);
    const packages: string[] = JSON.parse(dependencies);
    if (packages.length) await exec('python', ['-m','pip','install','--',...packages], 180000);
  }
  if (manifests.has('requirements.txt') || manifests.has('pyproject.toml')) await exec('python',['-m','pip','check']);
  if (manifests.has('reading/requirements.txt')) await exec('python',['-m','reading.run','setup'],60000);
  if (manifests.has('go.mod')) await exec('go',['mod','download'],180000);
  if (manifests.has('Cargo.toml')) await exec('cargo',['fetch'],180000);
  if (manifests.has('package.json')) {
    const locked = manifests.has('package-lock.json') || manifests.has('npm-shrinkwrap.json');
    await exec('npm', locked ? ['ci','--no-audit','--no-fund'] : ['install','--package-lock=false','--no-audit','--no-fund'],180000);
  }
  return digest;
}
