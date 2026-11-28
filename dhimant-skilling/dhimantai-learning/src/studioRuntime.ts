import {createHash, randomUUID} from 'node:crypto';
import {createServer, request} from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {findPodman, run} from './podman';

const exec = promisify(execFile);
const runner = '/opt/build-studio/runtime.py';
type Kind = 'live'|'practice'|'check';
export type CheckoutEvidence = {run:string; request:string; kind:Kind; revision:string; item:number; quantity:number|null;
  status:number|null; before:number|null; after:number|null};

interface DemonstrationRef {id:string; before?:string; file?:string; expected?:string}

export async function snapshot(root:string, attempt:string, label:string, buffers:ReadonlyMap<string,string> = new Map(), demo?:DemonstrationRef) {
  const dir = await mkdtemp(join(tmpdir(),'desk-index-'));
  const env = {...process.env, GIT_INDEX_FILE:join(dir,'index'), GIT_AUTHOR_NAME:label, GIT_COMMITTER_NAME:label,
    GIT_AUTHOR_EMAIL:'studio@dhimant.ai', GIT_COMMITTER_EMAIL:'studio@dhimant.ai'};
  const git = async (...args:string[]) => (await exec('git',['-c','core.hooksPath=','-c','core.fsmonitor=false',...args], {cwd:root,env})).stdout.trim();
  try {
    await git('read-tree','HEAD');
    const names=(await git('ls-files','--cached','--others','--exclude-standard','-z')).split('\0').filter(name=>
      name && !/(^|\/)(?:vendor|node_modules|storage|\.lab|\.env(?:\.|$)|dhimantai-cell-[^/]*\.jsx)(?:\/|$)/.test(name) &&
      !/^(?:bootstrap\/cache|public\/build)(?:\/|$)/.test(name));
    if(names.length){
      const paths=join(dir,'paths');
      await writeFile(paths,names.join('\0')+'\0');
      await git('--literal-pathspecs','add','-A','--pathspec-from-file='+paths,'--pathspec-file-nul');
    }
    let index = 0;
    for (const [name,text] of buffers) {
      if (!names.includes(name)) continue;
      const file = join(dir,'buffer-' + index++);
      await writeFile(file,text);
      const hash = await git('hash-object','-w',file);
      const mode = (await git('ls-files','--stage','--',name)).split(' ')[0] || '100644';
      await git('update-index','--add','--cacheinfo',mode,hash,name);
    }
    const tree = await git('write-tree');
    if (demo?.before) {
      const diff=await git('diff','--name-only','-z',demo.before,tree);
      const expectedFile=join(dir,'expected');
      await writeFile(expectedFile,demo.expected!);
      if(diff!==demo.file+'\0' || await git('rev-parse',tree+':'+demo.file)!==await git('hash-object',expectedFile))
        throw new Error('Your source changed during the demonstration. Inspect your edits before continuing.');
    }
    const commit = await git('commit-tree',tree,'-p',demo?.before??'HEAD','-m',label+' checkpoint');
    const reference=demo?'demos/'+demo.id+(demo.before?'/after':'/before'):'checkpoints/'+randomUUID();
    await git('update-ref','refs/dhimantai/attempts/'+attempt+'/'+reference,commit,'');
    return {tree,commit};
  } finally { await rm(dir,{recursive:true,force:true}); }
}

/** The live database belongs to the attempt, so moving or renaming its folder keeps the learner's inventory.
 * Pilot attempts created before this keyed the volume by folder path; keep using that volume when it exists. */
export async function liveVolume(bin:string, root:string, attempt:string) {
  const current = 'desk-state-attempt-'+attempt;
  const legacy = 'desk-state-'+createHash('sha256').update(root).digest('hex').slice(0,16);
  const exists = (name:string) => run(bin,['volume','exists',name]).then(()=>true,()=>false);
  return !await exists(current) && await exists(legacy) ? legacy : current;
}

interface StudioCheckCase {
  stock:number; quantity:number; expected:number; status:number|null; stockAndLoans:string; passed:boolean
}

/** Keep the observation with the revision that produced it, including on later visits. */
export function studioCheckFeedback(result:{setup?:string; passed:boolean; observations:StudioCheckCase[]}, revision:string) {
  const version = 'Checked revision ' + revision.slice(0,9);
  if (result.setup) return {report:version + ' · Could not check yet · ' + result.setup,
    guidance:'Which setup step can you verify before trying the checkout again?'};
  const rows = result.observations.map(r => (r.passed ? '✓ ' : '✗ ') + r.stock + ' available, borrow ' + r.quantity + ': '
    + (r.status === null ? 'no response' : 'HTTP ' + r.status) + (r.passed ? '' : ' (expected ' + r.expected + ')')
    + ' · stock, total loans, matching loans ' + r.stockAndLoans.split('\t').join(', '));
  const failed = result.observations.find(r => !r.passed);
  const report = [version + ' · ' + (result.passed && rows.length && !failed ? 'Passed' : 'Needs work'), ...rows].join('\n');
  if (!failed && (!result.passed || !rows.length)) return {report, guidance:'The check did not verify the checkout cases. Review the project check output before trying again.'};
  if (!failed) return {report, guidance:'All checkout cases passed for this revision. When the borrower requested exactly the stock on hand, what did the response and loan row show?'};
  const observed = failed.status === null ? 'the app did not respond' : 'the app returned HTTP ' + failed.status;
  const question = failed.status === failed.expected
    ? 'The response matched. Which stored value differed from your prediction?'
    : 'Where would you look first to explain that response?';
  return {report, guidance:'With ' + failed.stock + ' available and ' + failed.quantity + ' requested, ' + observed + '. ' + question};
}

export class StudioRun {
  private readonly gateway = createServer();
  private closed = false;
  url = '';
  private constructor(readonly bin:string,readonly container:string,readonly id:string,readonly kind:Kind,
      readonly revision:string, readonly attempt:string, readonly source:string, readonly image:string, readonly scratch?:string) {}

  static async start(root:string,attempt:string,image:string,kind:Kind,revision:string, tempRoot:string, onStatus?:(text:string)=>void) {
    if (!/^[\da-f-]{36}$/.test(attempt) || !/^[\da-f]{40,64}$/.test(revision)
        || !/^(?:sha256:[\da-f]{64}|[a-z0-9./:_-]+@sha256:[\da-f]{64})$/.test(image)) throw new Error('Invalid published run identity.');
    const bin = await findPodman();
    if (!bin) throw new Error('Install Podman to run Equipment Desk.');
    const id = randomUUID();
    let source = root, scratch:string|undefined, container:string|undefined;
    try {
      if (kind !== 'live') {
        await mkdir(tempRoot,{recursive:true});
        scratch = await mkdtemp(join(tempRoot,'practice-'));
        source = join(scratch,'source');
        // Keep this a local-path clone. It copies the whole object store, including the snapshot commit,
        // which only private refs reach. A file:// URL or --no-local would fetch branches only and lose it.
        await exec('git',['-c','core.hooksPath=','clone','--no-checkout','--no-hardlinks',root,source],{timeout:30000});
        await exec('git',['-c','core.hooksPath=','checkout','--detach',revision],{cwd:source,timeout:30000});
      }
      const uid=process.getuid?.() ?? 1000, gid=process.getgid?.() ?? 1000;
      const volumes = ['-v',(kind==='live'?await liveVolume(bin,root,attempt):'desk-state-'+id)+':/studio-state:U'];
      const socket = 'desk-socket-'+id;
      // An explicit pull by digest is needed on a fresh learner installation.
      if (!await run(bin,['image','exists',image]).then(()=>true,()=>false)) {
        onStatus?.('Downloading the Equipment Desk runtime for this device. The first download can take several minutes.');
        // Allow a cold installation to fetch the full runtime on a slower connection.
        await run(bin,['pull',image],30*60_000);
        onStatus?.('');
      }
      // Disposable runs copy only their frozen source across the desktop filesystem.
      // Dependency installation and the build then stay on a private Linux volume.
      const projectMount=kind==='live'?['-v',source+':/course:z']:
        ['-v',source+':/studio-source:ro,z','-v','desk-source-'+id+':/course:U'];
      const startCommand=kind==='live'?['python3',runner,'serve']:
        ['sh','-ec','cp -a --no-preserve=ownership /studio-source/. /course/ && exec python3 /opt/build-studio/runtime.py serve'];
      container = await run(bin,['run','-d','--name','desk-'+id,'--label','ai.dhimant.attempt='+attempt,'--label','ai.dhimant.studio-kind='+kind,
        ...(process.platform==='linux'?['--userns=keep-id']:[]),'--user',uid+':'+gid,'--security-opt','no-new-privileges','--pids-limit','512','--memory','1536m','--cpus','2',
        '--publish','127.0.0.1::8000',...projectMount,'-v',socket+':/studio-socket:z,U',...volumes,
        '-e','STUDIO_RUN='+id,'-e','STUDIO_KIND='+kind,'-e','STUDIO_REVISION='+revision,image,...startCommand],60000);
      const studio = new StudioRun(bin,container,id,kind,revision,attempt,source,image,scratch);
      const binding = await run(bin,['port',container,'8000/tcp']);
      const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1]);
      if (!port) throw new Error('Podman did not publish the learner app on loopback.');
      let ready = false;
      const deadline=Date.now()+180000;
      for (let i=0;i<360 && Date.now()<deadline;i++) {
        const response = await fetch('http://127.0.0.1:'+port+'/_studio/ready',{headers:{'X-Studio-Run':id},signal:AbortSignal.timeout(800)}).catch(()=>undefined);
        if (response?.ok && response.headers.get('X-Studio-Run')===id) { ready=true; break; }
        if (i%8===0 && (await run(bin,['inspect','--format','{{.State.Running}}',container]))!=='true')
          throw new Error('Equipment Desk could not start. '+(await run(bin,['logs','--tail','4',container])).slice(-500));
        await new Promise(resolve=>setTimeout(resolve,350));
      }
      if (!ready) throw new Error('Equipment Desk did not become ready.');
      await studio.listen(port);
      return studio;
    } catch(error) {
      // Remove the named run even if the launch command timed out before returning its ID.
      await run(bin,['rm','--ignore','--time','2','-f',container??'desk-'+id],60000);
      if (kind!=='live') await run(bin,['volume','rm','desk-source-'+id]).catch(()=>undefined);
      await run(bin,['volume','rm','desk-socket-'+id]).catch(()=>undefined);
      if (kind!=='live') await run(bin,['volume','rm','desk-state-'+id]).catch(()=>undefined);
      if(scratch) await rm(scratch,{recursive:true,force:true});
      throw error;
    }
  }

  private async listen(port:number) {
    const host = this.id+'.localhost';
    this.gateway.on('request',(req,res)=>{
      if(this.closed || req.headers.host !== new URL(this.url).host) { res.writeHead(410).end('Run ended'); return; }
      // Node decodes streamed browser bodies. Send their actual length on the container hop.
      const chunks:Buffer[]=[];
      let size=0;
      req.on('data',(chunk:Buffer)=>{
        size+=chunk.length;
        if(size<=65536)chunks.push(chunk);
        else if(!res.writableEnded)res.writeHead(413).end();
      });
      req.on('end',()=>{
        if(res.writableEnded || this.closed)return;
        const headers={...req.headers,'x-studio-run':this.id,'content-length':String(size)};
        delete headers['transfer-encoding'];
        const upstream=request({host:'127.0.0.1',port,path:req.url,method:req.method,headers,timeout:15000},reply=>{
          res.writeHead(reply.statusCode??502,reply.headers); reply.pipe(res);
        });
        upstream.on('timeout',()=>upstream.destroy());
        upstream.on('error',()=>{if(!res.headersSent) res.writeHead(502); res.end('Equipment Desk could not respond.');});
        upstream.end(Buffer.concat(chunks,size));
      });
    });
    await new Promise<void>((resolve,reject)=>{this.gateway.once('error',reject); this.gateway.listen(0,'127.0.0.1',resolve);});
    const address=this.gateway.address();
    if (!address || typeof address==='string') throw new Error('Could not open the learner preview.');
    this.url='http://'+host+':'+address.port;
  }

  async snippet(language:'php'|'sql', source:string, execution:string) {
    if (this.closed || this.kind !== 'live' || source.length>12000) throw new Error('Open the active live desk before running a snippet.');
    const payload={language,source,execution};
    const args=['exec','-i','--workdir','/course',this.container,'python3','/opt/build-studio/console.py'];
    const result=await new Promise<string>((resolve,reject)=>{
      const child=spawn(this.bin,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,timeout:30000});
      let output='',diagnostic='';
      child.stdout.on('data',chunk=>{output+=chunk;if(output.length>150000)child.kill();});
      child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-400);});
      child.once('error',reject); child.stdin.on('error',()=>{});
      child.once('close',code=>code===0?resolve(output):reject(new Error('Console setup failed. '+diagnostic)));
      child.stdin.end(JSON.stringify(payload));
    });
    return JSON.parse(result);
  }

  async check(harness:string){
    if(this.kind!=='check')throw new Error('Use a disposable project check.');
    const result=JSON.parse(await run(this.bin,['exec','--workdir','/opt/build-studio',this.container,'python3','-c',harness]));
    return studioCheckFeedback(result, this.revision);
  }
  async inventory():Promise<Map<string,number>> {
    const rows: [string,string][]=JSON.parse(await run(this.bin,['exec',this.container,'python3',runner,'inventory']));
    return new Map(rows.map(([name,n])=>[name,Number(n)]));
  }
  /** Every checkout recorded in this run, oldest first. Images released before the list existed report only the last one. */
  async checkouts():Promise<CheckoutEvidence[]> {
    const list=await run(this.bin,['exec',this.container,'python3',runner,'checkouts']).then(out=>JSON.parse(out)).catch(()=>undefined);
    if(!Array.isArray(list)){const last=await this.evidence();return last?[last]:[];}
    return list.filter((data:CheckoutEvidence)=>data&&data.run===this.id&&data.kind===this.kind&&data.revision===this.revision);
  }
  async evidence():Promise<CheckoutEvidence|null> {
    const data=JSON.parse(await run(this.bin,['exec',this.container,'python3',runner,'evidence']));
    if (!data || data.run!==this.id || data.kind!==this.kind || data.revision!==this.revision) return null;
    return data;
  }
  async close() {
    if(this.closed) return;
    this.closed=true;
    this.gateway.close(); this.gateway.closeAllConnections();
    await run(this.bin,['rm','--ignore','--time','2','-f',this.container],60000);
    if(this.kind!=='live')await run(this.bin,['volume','rm','desk-source-'+this.id]);
    await run(this.bin,['volume','rm','desk-socket-'+this.id]).catch(()=>undefined);
    if (this.kind!=='live') await run(this.bin,['volume','rm','desk-state-'+this.id]).catch(()=>undefined);
    if(this.scratch) await rm(this.scratch,{recursive:true,force:true});
  }
}
