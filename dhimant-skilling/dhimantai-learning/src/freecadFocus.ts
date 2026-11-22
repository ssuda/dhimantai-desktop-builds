import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const run=promisify(execFile);
interface Target {pid:number;title:string}
export function exerciseWindow(target:Target,windows:{pid:number;window_id:number;title:string}[]) {
  const title=(value:string)=>value.replace(/\[\*\]/g,'').replace(/^\s*\*\s*/,'').trim();
  const matches=windows.filter(w=>w.pid===target.pid && typeof w.title==='string' && title(w.title)===title(target.title)
    && Number.isSafeInteger(w.window_id) && w.window_id>0);
  return matches.length===1?matches[0].window_id:undefined;
}

/** Present the exact drawing for a demo using an already-running local Cua Driver. */
export async function presentFreeCAD(target:Target,signal:AbortSignal) {
  if(!Number.isSafeInteger(target.pid)||!target.title || signal.aborted)return false;
  const cli=process.platform==='win32'?'cua-driver.exe':'cua-driver';
  let executable=cli;
  for(const file of [join(homedir(),'.local','bin',cli),...(process.platform==='darwin'?['/Applications/CuaDriver.app/Contents/MacOS/cua-driver']:[])]) {
    if(await access(file).then(()=>true,()=>false)){executable=file;break;}
  }
  const options={windowsHide:true,timeout:1200,maxBuffer:64*1024,signal:AbortSignal.any([signal,AbortSignal.timeout(1200)])};
  try {
    // The status commands are read-only. Never start a consent flow from a lesson.
    if(process.platform==='darwin'){
      const state=JSON.parse((await run(executable,['permissions','status','--json'],options)).stdout);
      if(state.accessibility!==true || state.screen_recording!==true)return false;
    } else await run(executable,['status'],options);
    const call=async(method:string,args:object)=>JSON.parse((await run(executable,['call',method,JSON.stringify(args)],options)).stdout);
    const {windows}=await call('list_windows',{pid:target.pid});
    if(!Array.isArray(windows))return false;
    const id=exerciseWindow(target,windows);
    if(!id)return false;
    await call('bring_to_front',{pid:target.pid,window_id:id});
    return true;
  } catch {return false;} // The FreeCAD GUI can also present its own document.
}
