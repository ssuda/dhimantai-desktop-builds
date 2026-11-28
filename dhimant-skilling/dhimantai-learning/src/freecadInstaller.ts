import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, createWriteStream} from 'node:fs';
import {access, chmod, mkdir, mkdtemp, readdir, rename, rm, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';

const run = promisify(execFile);
const version = '1.1.4';
const packages: Record<string, [string, string]> = {
  'darwin-arm64':['macOS-arm64-py311.dmg','071343b4abb70492b75c973f41eaf1d2528f9b9c7ea018d22a4f46ae14d27ac0'],
  'darwin-x64':['macOS-x86_64-py311.dmg','e173d0dcf47a5166b59cbb33adccf54cd751eb9ceaa2c86486230d0d079648c1'],
  'linux-arm64':['Linux-aarch64-py311.AppImage','675d1a4295b2183e0e1d816a4b5557dcb63aeced4e60aaa28d6c3686f4c71dc9'],
  'linux-x64':['Linux-x86_64-py311.AppImage','f6dc6ba676e5ac96a565ebc8d657232f94c6158e85b4352141bd1a46f6b43434'],
  'win32-x64':['Windows-x86_64-py311.7z','4828741fc91ee37fafcdb97a1abacb18b04ba451ac4372d9ff7a7349b36f4d6d'],
};

async function executable(file: string) {
  try {await access(file, constants.X_OK); return (await stat(file)).isFile();} catch {return false;}
}
async function names(folder: string) {
  return readdir(folder).catch(() => [] as string[]);
}
async function inFolder(folder: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const entries=(await names(folder)).filter(n=>/^freecad/i.test(n)).sort().reverse();
  for (const prefix of [folder,...entries.map(n=>join(folder,n))]) {
    const file = platform==='darwin' ? join(prefix,'Contents','MacOS','FreeCAD')
      : platform==='win32' ? join(prefix,'bin','FreeCAD.exe') : join(prefix,'AppRun');
    if(await executable(file))return file;
  }
}
type Installation={command:string;flatpak?:string};
export async function installedFreeCAD(root: string): Promise<Installation|undefined> {
  const platform=process.platform;
  const managed=await inFolder(join(root,'FreeCAD-'+version),platform);
  if(managed)return {command:managed};
  for(const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for(const name of platform==='win32'?['FreeCAD.exe']:['freecad','FreeCAD']) {
      const file=join(directory,name);
      if(await executable(file))return {command:file};
    }
  }
  const folders = platform==='darwin'?['/Applications',join(homedir(),'Applications')]
    : platform==='win32'?[process.env.ProgramFiles,join(process.env.LOCALAPPDATA || homedir(),'Programs')]
    : ['/opt',join(homedir(),'Applications')];
  for(const folder of folders)if(folder) {
    const file=await inFolder(folder,platform);
    if(file)return {command:file};
    if(platform==='linux')for(const name of (await names(folder)).sort().reverse()) {
      if(/^freecad.*\.appimage$/i.test(name) && await executable(join(folder,name)))return {command:join(folder,name)};
    }
  }
  if(platform==='win32') {
    for(const hive of ['HKCU','HKLM']) {
      try {
        const registry=join(process.env.SystemRoot || 'C:\\Windows','System32','reg.exe');
        const {stdout}=await run(registry,['query',hive+'\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\FreeCAD.exe','/ve'],{timeout:3000,windowsHide:true});
        const file=stdout.match(/REG_SZ\s+(.+?)(?:\r?\n|$)/)?.[1]?.trim().replace(/^"|"$/g,'');
        if(file && await executable(file))return {command:file};
      } catch { /* Portable installations can run without registering an app path. */ }
    }
  }
  if(platform==='linux') {
    for(const launcher of ['/snap/bin/freecad','/var/lib/snapd/snap/bin/freecad']) {
      if(await executable(launcher))return {command:launcher};
    }
    for(const id of ['org.freecad.FreeCAD','org.freecadweb.FreeCAD']) {
      try {
        await run('flatpak',['info',id],{timeout:3000});
        return {command:'flatpak',flatpak:id};
      } catch { /* Try the other application ID or the managed release. */ }
    }
  }
}

const installs = new Map<string,Promise<string>>();
export async function ensureFreeCAD(root: string, progress: (message: string)=>void) {
  const installed=await installedFreeCAD(root);
  if(installed)return installed;
  progress('Installing FreeCAD for this account…');
  let job=installs.get(root);
  if(!job) {
    job=install(root,progress).finally(()=>installs.delete(root));
    installs.set(root,job);
  }
  return {command:await job};
}

async function install(root: string,progress:(message:string)=>void) {
  const platform=process.platform;
  const asset=packages[platform+'-'+process.arch];
  if(!asset)throw new Error('FreeCAD has no pilot download for this processor. Install FreeCAD and reopen the lesson.');
  await mkdir(root,{recursive:true,mode:0o700});
  const stage=await mkdtemp(join(root,'.install-')), destination=join(root,'FreeCAD-'+version);
  const payload=join(stage,'app'), archive=join(stage,'FreeCAD_'+version+'-'+asset[0]);
  try {
    const response=await fetch('https://github.com/FreeCAD/FreeCAD/releases/download/'+version+'/FreeCAD_'+version+'-'+asset[0],
      {signal:AbortSignal.timeout(25*60_000)});
    if(!response.ok || !response.body)throw new Error('FreeCAD download failed (HTTP '+response.status+'). Reopen the lesson to retry.');
    const digest=createHash('sha256');
    const size=Number(response.headers.get('content-length'));
    let received=0, milestone=0;
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),new Transform({
      transform(chunk,_encoding,callback){
        digest.update(chunk);received+=chunk.length;
        const percent=size>0 ? Math.floor(received/size*10)*10 : 0;
        if(percent>milestone){milestone=percent;progress('Downloading FreeCAD · '+percent+'%');}
        callback(null,chunk);
      }
    }),createWriteStream(archive,{flags:'wx',mode:0o600}));
    if(digest.digest('hex')!==asset[1])throw new Error('The FreeCAD download failed its integrity check. Reopen the lesson to retry.');
    progress('Preparing the verified FreeCAD installation…');
    await mkdir(payload);
    const opts={timeout:10*60_000,maxBuffer:1024*1024,windowsHide:true};
    if(platform==='darwin') {
      const mount=join(stage,'volume');
      await mkdir(mount);
      await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,archive],opts);
      try {
        const app=(await readdir(mount)).find(n=>/^FreeCAD.*\.app$/i.test(n));
        if(!app)throw new Error('FreeCAD was missing from the downloaded disk image.');
        await run('/usr/bin/ditto',[join(mount,app),join(payload,app)],opts);
      } finally {await run('/usr/bin/hdiutil',['detach',mount],opts);}
    } else if(platform==='win32') {
      await run(join(process.env.SystemRoot || 'C:\\Windows','System32','tar.exe'),['-xf',archive,'-C',payload],opts);
    } else {
      await chmod(archive,0o700);
      // Extract once. The installed AppRun also works on machines without FUSE.
      await run(archive,['--appimage-extract'],{...opts,cwd:stage,maxBuffer:32*1024*1024});
      await rename(join(stage,'squashfs-root'),join(payload,'FreeCAD'));
    }
    if(!await inFolder(payload,platform))throw new Error('The extracted FreeCAD executable could not be found.');
    try {await rename(payload,destination);} catch(error) {
      if(!await inFolder(destination,platform))throw error;
    }
    return (await inFolder(destination,platform))!;
  } finally {await rm(stage,{recursive:true,force:true});}
}
