import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { ProjectRun, ProjectStep } from './projectCore';

export const gitProjects = {'festival-desk':'Festival desk', 'orchard-deliveries':'Orchard deliveries'};
export type GitProject = keyof typeof gitProjects;
export function isGitProject(id: string): id is GitProject { return Object.hasOwn(gitProjects, id); }
export const gitSkills = ['branch', 'commits', 'conflict'] as const;
export type GitSkill = typeof gitSkills[number];
export interface GitExercise {
  base:string; team:string; policy:string; local:Record<string, unknown>; combined:Record<string, unknown>;
  other:string; otherValue:Record<string, unknown>;
}
export interface GitEvidence { skills:GitSkill[]; complete:boolean }

function descriptive(subject: string) {
  return /\p{L}.{3}/u.test(subject.trim()) && !/^(?:fixup!|squash!|wip\b)|^(?:update|fix|changes?|commit|done|misc|test)(?:\s+(?:files?|changes?|stuff|things|it|all))?[.!]?$/i.test(subject.trim());
}

/** Replay only the text merge in a temporary folder. The worktree, refs and index belong to the student. */
async function parentsConflict(base: string, local: string, incoming: string, signal: AbortSignal) {
  const folder = await mkdtemp(join(tmpdir(), 'instructor-merge-'));
  try {
    await Promise.all([['base',base],['local',local],['incoming',incoming]].map(([name,text]) => writeFile(join(folder,name),text)));
    await promisify(execFile)('git', ['merge-file','-p','local','base','incoming'], {cwd:folder, signal, timeout:5000});
    return false;
  } catch (error) {
    const failure = error as {code?:number; stdout?:string};
    if (failure.code === 1 && failure.stdout?.includes('<<<<<<< local')) return true;
    throw error;
  } finally { await rm(folder,{recursive:true,force:true}); }
}

export async function checkGitPractice(root:string, spec:GitExercise, step:ProjectStep, digest:string, signal:AbortSignal): Promise<ProjectRun> {
  const run = async (...args:string[]) => (await promisify(execFile)('git', ['--no-optional-locks','--no-replace-objects',
    '-c','core.fsmonitor=false', ...args], {cwd:root, timeout:5000, signal, maxBuffer:512000})).stdout;
  const ref = async (name:string) => (await run('rev-parse','--verify',name)).trim();
  const files = async (from:string,to:string) => (await run('diff','--no-ext-diff','--no-textconv','--name-only','-z',from,to,'--')).split('\0').filter(Boolean);
  const blob = (commit:string,path:string) => run('cat-file','blob',commit+':'+path);
  const matches = async (commit:string,path:string,expected:unknown) => {
    // Check path existence first. A learner may have deleted or renamed one of the required files.
    if (!(await run('ls-tree','--name-only',commit,'--',path)).trim()) return false;
    const text = await blob(commit,path);
    try { return isDeepStrictEqual(JSON.parse(text),expected); } catch { return false; }
  };
  const skills:GitSkill[] = [];
  const receipt = (output:string, complete=false):ProjectRun => ({step:step.id,digest,command:'Check Git history',
    status:complete ? 'passed' : 'failed',output,truncated:false,gitEvidence:{skills,complete}});
  if (await realpath((await run('rev-parse','--show-toplevel')).trim()) !== await realpath(root))
    return receipt('Open the practice repository to check its history.');
  const branch = (await run('rev-parse','--abbrev-ref','HEAD')).trim(), head = await ref('HEAD');
  const main = (await run('for-each-ref','--format=%(objectname)','refs/heads/main')).trim();
  if (branch === 'HEAD' || branch === 'main' || main !== spec.base)
    return receipt('The review needs a named working branch with main at the starting commit.');
  const log = (await run('rev-list','--first-parent','--parents','--max-count=65','--reverse',spec.base+'..'+head)).trim();
  const history = log ? log.split('\n').map(line => line.split(' ')) : [];
  if (!history.length || history.length > 64 || history[0][1] !== spec.base || history[0][0] === spec.team || history[0].length !== 2)
    return receipt('The review needs work committed on your branch from the starting point.');
  const mergeIndex = history.findIndex(row => row.length > 2);
  const changes = mergeIndex < 0 ? history : history.slice(0,mergeIndex);
  const purposes = new Set<string>(), subjects = new Set<string>();
  let changedOnBranch = false;
  for (const [commit,parent] of changes) {
    const paths = await files(parent,commit);
    if (paths.length) changedOnBranch = true;
    if (paths.length !== 1) continue;
    const path = paths[0];
    const value = path === spec.policy ? spec.local : path === spec.other ? spec.otherValue : undefined;
    if (value && await matches(commit,path,value)) {
      const subject = (await run('show','-s','--format=%s',commit)).trim();
      if (descriptive(subject)) { purposes.add(path); subjects.add(subject.toLowerCase()); }
    }
  }
  if (!changedOnBranch) return receipt('The branch needs a committed change of its own.');
  skills.push('branch');
  if (changes.length === 2 && purposes.size === 2 && subjects.size === 2) skills.push('commits');
  const merge = history[mergeIndex];
  if (merge?.length === 3 && merge[2] === spec.team && await matches(merge[1],spec.policy,spec.local)
      && await matches(merge[0],spec.policy,spec.combined) && await matches(head,spec.policy,spec.combined)) {
    const sides = await Promise.all([spec.base,merge[1],spec.team].map(commit => blob(commit,spec.policy)));
    if (await parentsConflict(sides[0],sides[1],sides[2],signal)) skills.push('conflict');
  }
  const paths = await files(spec.base,head);
  const clean = !(await run('status','--porcelain=v1','--untracked-files=all')).length;
  const complete = skills.length === 3 && merge?.[0] === head && clean && paths.length === 2 &&
    paths.includes(spec.policy) && paths.includes(spec.other) && await matches(head,spec.other,spec.otherValue);
  const lines = ['Working branch verified.',
    skills.includes('commits') ? 'Two focused commits with descriptive subjects verified.' : 'The history needs two separately reviewable changes with descriptive subjects.',
    skills.includes('conflict') ? 'The merge preserves both conflicting changes.' : 'The merge resolution has yet to show both intended changes.'];
  if (skills.length === 3 && !complete) lines.push('Check the final tree, merge tip and outstanding local changes against the brief.');
  return receipt(lines.join('\n'),complete);
}
