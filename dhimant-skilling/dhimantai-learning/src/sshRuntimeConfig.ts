import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {CourseConfiguration} from './courseConfiguration';

export interface SshHost {host:string; port?:number; identity?:string; jump?:string; cloudVm?:boolean}
export interface GpuLabRequirement {
  version:1; recipe:string; nodes:number; gpusPerNode:number; minVramMiB:number; minComputeCapability:number;
  python:string; uv:string; vllm:string; ray:string; ipython:string; model:string; revision:string; bareMachineOs:string[];
  layouts?:{nodes:number;gpusPerNode:number;label:string}[];
  managedContainer?:boolean;
}
const destination=/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Accept the common VS Code Add SSH Host input, never arbitrary SSH flags or remote commands. */
export function parseSshHost(value:string):SshHost {
  if(/[\r\n\0]/.test(value))throw new Error('Enter one SSH connection without line breaks.');
  if(!/^(?:[^'"\s]+|'[^']*'|"[^"]*"|\s+)*$/.test(value))throw new Error('Close the quotes around your SSH options.');
  const words=value.trim().match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g)?.map(word=>/^['"]/.test(word)?word.slice(1,-1):word) ?? [];
  if(words[0]==='ssh')words.shift();
  const result:SshHost={host:''};
  for(let i=0;i<words.length;i++) {
    const word=words[i];
    if(['-p','-i','-J'].includes(word)) {
      const next=words[++i];if(!next)throw new Error('The SSH option needs a value.');
      if(word==='-p') {if(!/^\d+$/.test(next)||+next<1||+next>65535)throw new Error('Use an SSH port from 1 to 65535.');result.port=+next;}
      if(word==='-i') {if(/[\r\n\0]/.test(next)||next.startsWith('-'))throw new Error('Choose a valid private-key file.');result.identity=next.replace(/^~(?=[/\\])/,homedir());}
      if(word==='-J') {if(!destination.test(next))throw new Error('Use an SSH config alias for the jump host.');result.jump=next;}
    } else if(!result.host && destination.test(word) && !word.startsWith('-')) result.host=word;
    else throw new Error('Enter user@host or an SSH config host. Supported options: -p port, -i key-file, -J jump-host.');
  }
  if(!result.host)throw new Error('Enter an SSH host.');
  return result;
}
export const hostLabel=(host:SshHost)=>host.host+(host.port?':'+host.port:'');
export const quoteSh=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
export function sshArgs(host:SshHost,command:string) {
  if(!destination.test(host.host) || host.host.startsWith('-'))throw new Error('Invalid SSH host.');
  return ['-T','-o','ConnectTimeout=20','-o','ConnectionAttempts=1','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
    '-o','NumberOfPasswordPrompts=3','-o','StrictHostKeyChecking=ask','-o','ForwardAgent=no',
    ...(host.cloudVm?['-o','UserKnownHostsFile=~/.ssh/known_hosts','-o','HostKeyAlias='+host.host]:[]),
    ...(host.port?['-p',String(host.port)]:[]),...(host.identity?['-i',host.identity]:[]),...(host.jump?['-J',host.jump]:[]),host.host,command];
}
export async function configuredSshHosts(file=join(homedir(),'.ssh','config')) {
  try {return [...new Set((await readFile(file,'utf8')).split(/\r?\n/).flatMap(line=>{
    const match=line.match(/^\s*Host\s+(.+?)(?:\s+#.*)?$/i);
    return match?match[1].trim().split(/\s+/).filter(host=>destination.test(host)&&!host.startsWith('-')):[];
  }))];}catch{return [];}
}
export function gpuLabRequirement(configuration:CourseConfiguration,lesson:string,chapter=''):GpuLabRequirement|undefined {
  const labs=configuration.gpu.labs;
  const value=Object.hasOwn(labs,lesson)?labs[lesson]:Object.hasOwn(labs,chapter)?labs[chapter]:configuration.gpu.default;
  return value??undefined;
}
