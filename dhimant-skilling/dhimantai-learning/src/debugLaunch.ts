import type { DebugConfiguration } from 'vscode';
import { join } from 'node:path';
import type { Toolchains } from './localRunner';

export const debugExtension = (language: string, course: boolean) => ({python:'ms-python.debugpy',
  javascript:'ms-vscode.js-debug', typescript:'ms-vscode.js-debug', java:'vscjava.vscode-java-debug', go:'golang.go',
  c:course ? 'ms-vscode.cpptools' : 'vadimcn.vscode-lldb', rust:course ? 'ms-vscode.cpptools' : 'vadimcn.vscode-lldb'}[language]);

export function localDebugLaunch(language: string, folder: string, port: number, tools: Toolchains, debugpy: string, windows = process.platform === 'win32', argv:string[] = []) {
  const base = {name:'dhimantAI · Debug notebook cell', request:'attach', port};
  let launch: DebugConfiguration, server: string[] | undefined;
  switch (language) {
    case 'python':
      launch = {name:base.name,request:'attach',type:'debugpy',connect:{host:'127.0.0.1',port},justMyCode:true,redirectOutput:true};
      server = [tools.python ?? (windows ? 'python' : 'python3'), debugpy, '--log-to-stderr', '--listen', `127.0.0.1:${port}`, '--wait-for-client', 'main.py']; break;
    case 'javascript': case 'typescript':
      launch = {...base,type:'pwa-node',address:'127.0.0.1',cwd:folder,localRoot:folder,remoteRoot:folder,
        sourceMaps:true,outFiles:[join(folder,'*.js')],skipFiles:['<node_internals>/**']};
      server = [tools.node ?? 'node', `--inspect-brk=127.0.0.1:${port}`, 'main.js']; break;
    case 'java':
      launch = {...base,type:'java',hostName:'127.0.0.1',sourcePaths:[folder]};
      server = [tools.java ?? 'java', `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`, '-cp','.', 'Main']; break;
    case 'go':
      launch = {...base,type:'go',mode:'remote',debugAdapter:'dlv-dap',host:'127.0.0.1',substitutePath:[{from:folder,to:folder}]};
      server = ['dlv','exec',windows ? 'main.exe' : './main','--headless',`--listen=127.0.0.1:${port}`,'--api-version=2','-r','stdin.txt']; break;
    case 'c': case 'rust':
      launch = {name:base.name,type:'lldb',request:'launch',program:join(folder,windows ? 'main.exe' : 'main'),cwd:folder,
        stopOnEntry:true,stdio:[join(folder,'stdin.txt'),null,null]}; break;
    default: throw new Error('This cell language has no native debugger configuration.');
  }
  if(server)server.push(...(language==='go'?['--',...argv]:argv));
  else launch.args=argv;
  return {launch,server};
}
