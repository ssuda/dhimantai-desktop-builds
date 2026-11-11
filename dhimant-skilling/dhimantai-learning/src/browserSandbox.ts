/** Curated application sandboxes. No notebook, web page or learner input can supply container commands. */
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, stream, stopCourseRuntime } from './podman';

export const ERP_IMAGES = {
  erpnext: 'docker.io/frappe/erpnext@sha256:32145acc7f699dc598ca141018a95ebf8e56f516d4a0e76beb7287ae68b303b8',
  db: 'docker.io/library/mariadb@sha256:c4124d1afa875e47f2892edf26b482fa54f796e2f342d3717a04ca091a22a9bd',
  redis: 'docker.io/library/redis@sha256:7b1753b4c5ad8458906c272a8132b8c15f5557b000379eb115fb239706a384b7',
};
export function sandboxKey(scope: string) { return createHash('sha256').update(scope).digest('hex').slice(0, 20); }
export function sandboxPort(output: string): number {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(output.trim());
  if (!match || +match[1] < 1 || +match[1] > 65535) throw new Error('ERPNext must listen only on this computer.');
  return +match[1];
}
export interface SandboxService { id: string; image: string; memory: string; args?: string[]; env?: string[]; volumes?: string[]; command?: string[] }
export function erpServices(image: string): SandboxService[] {
  const volumes = ['sites:/home/frappe/frappe-bench/sites', 'logs:/home/frappe/frappe-bench/logs'];
  return [
    {id:'db', image:ERP_IMAGES.db, memory:'1g', volumes:['db:/var/lib/mysql'],
      command:['--character-set-server=utf8mb4','--collation-server=utf8mb4_unicode_ci','--skip-character-set-client-handshake','--innodb-snapshot-isolation=OFF']},
    ...['redis-cache','redis-queue'].map(id => ({id,image:ERP_IMAGES.redis,memory:'256m',command:['redis-server','--appendonly','yes'],volumes:[id + ':/data']})),
    {id:'backend',image,memory:'1536m',volumes},
    {id:'websocket',image,memory:'256m',volumes,command:['node','/home/frappe/frappe-bench/apps/frappe/socketio.js']},
    {id:'worker',image,memory:'768m',volumes,command:['bench','worker','--queue','long,default,short']},
    {id:'scheduler',image,memory:'256m',volumes,command:['bench','schedule']},
    {id:'frontend',image,memory:'256m',volumes,command:['nginx-entrypoint.sh'],args:['--publish','127.0.0.1::8080'],
      env:['BACKEND=backend:8000','FRAPPE_SITE_NAME_HEADER=frontend','SOCKETIO=websocket:9000','PROXY_READ_TIMEOUT=120']},
  ];
}
export class ErpSandbox {
  private names: string[] = [];
  constructor(private readonly bin: string, private readonly media: string, readonly key: string,
      private readonly log: (text: string) => void) {
    if (!/^[a-f0-9]{20}$/.test(key)) throw new Error('Invalid sandbox identity.');
  }
  private get prefix() { return 'dhimantai-erp-' + this.key; }
  async start(password: string, learner: {id:string; password:string}, report: (message: string) => void): Promise<string> {
    if (!/^[a-f0-9]{48}$/.test(password) || !/^[a-f0-9]{48}$/.test(learner.password) || !/^[a-f0-9]{20}$/.test(learner.id))
      throw new Error('Invalid sandbox credential.');
    const memory = Number(await run(this.bin,['info','--format','{{.Host.MemTotal}}']));
    if (memory < 6_000_000_000) throw new Error('ERPNext needs at least 6 GB allocated to the course runtime. Increase Podman machine memory, then retry.');
    const hash = createHash('sha256').update('sandbox-v2');
    for (const name of (await readdir(this.media)).sort()) { hash.update(name); hash.update(await readFile(join(this.media,name))); }
    const version = hash.digest('hex').slice(0,20), image = 'localhost/dhimantai-erpnext:' + version;
    const exists = async (kind: string, name: string) => run(this.bin,[kind,'exists',name]).then(() => true, () => false);
    if (!await exists('image',image)) {
      report('Preparing the ERPNext training image. The first download can take several minutes.');
      await stream(this.bin,['build','--tag',image,this.media],this.log);
    }
    if (!await exists('network',this.prefix)) await run(this.bin,['network','create','--internal',this.prefix]);
    // The frontend needs a route back to the host's published port; the database and workers stay on the internal network.
    if (!await exists('network',this.prefix+'-web')) await run(this.bin,['network','create',this.prefix+'-web']);
    for (const id of ['db','sites','logs','redis-cache','redis-queue'])
      if (!await exists('volume',this.prefix + '-' + id)) await run(this.bin,['volume','create',this.prefix + '-' + id]);
    const services = erpServices(image);
    this.names = services.map(s => this.prefix + '-' + s.id);
    // Replace only our stopped/running service containers when the bundled guide changes; preserve all data volumes.
    for (const name of this.names) {
      if (await exists('container',name)) {
        const old = await run(this.bin,['inspect','--format','{{index .Config.Labels "ai.dhimant.browser-version"}}',name]);
        if (old !== version) { await this.stop(); break; }
      }
    }
    const secrets = await mkdtemp(join(tmpdir(),'dhimantai-erp-'));
    try {
      const envFile = join(secrets,'credentials.env');
      const dbFile = join(secrets,'database.env');
      await writeFile(dbFile,`MARIADB_ROOT_PASSWORD=${password}\n`,{mode:0o600});
      await writeFile(envFile,`MARIADB_ROOT_PASSWORD=${password}\nDHIMANTAI_ADMIN_PASSWORD=${password}\nDHIMANTAI_LEARNER=${learner.id}\nDHIMANTAI_LEARNER_PASSWORD=${learner.password}\n`,{mode:0o600});
      const start = async (s: SandboxService) => {
        const name = this.prefix + '-' + s.id;
        if (await exists('container',name)) {
          const old = await run(this.bin,['inspect','--format','{{index .Config.Labels "ai.dhimant.browser-version"}}',name]);
          if (old !== version) await run(this.bin,['rm',name]);
        }
        if (await exists('container',name)) { await run(this.bin,['start',name]); return; }
        const args = ['run','--detach','--name',name,'--network',this.prefix,'--network-alias',s.id,
          '--label','ai.dhimant.browser=' + this.key,'--label','ai.dhimant.browser-version=' + version,
          '--memory',s.memory,'--cpus','2','--pids-limit','256',...(s.args ?? [])];
        if(s.id==='frontend')args.push('--network',this.prefix+'-web');
        for (const v of s.volumes ?? []) args.push('--volume',this.prefix + '-' + v);
        for (const e of s.env ?? []) args.push('--env',e);
        if (s.id === 'db') args.push('--env-file',dbFile);
        await run(this.bin,[...args,s.image,...(s.command ?? [])],600000);
      };
      report('Starting the training database');
      for (const s of services.slice(0,3)) await start(s);
      let ready = false;
      for (let i=0;i<90;i++) {
        ready = await run(this.bin,['exec',this.prefix + '-db','healthcheck.sh','--connect','--innodb_initialized']).then(() => true, () => false);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve,1000));
      }
      if (!ready) throw new Error('The ERPNext database did not become ready. Retry setup.');
      report('Preparing your training company and guided lessons');
      await stream(this.bin,['run','--rm','--name',this.prefix + '-setup','--network',this.prefix,
        '--memory','2g','--cpus','2','--pids-limit','256','--env-file',envFile,
        '--volume',this.prefix + '-sites:/home/frappe/frappe-bench/sites',
        '--volume',this.prefix + '-logs:/home/frappe/frappe-bench/logs',
        image,'timeout','600','bash','/opt/dhimantai/setup.sh'],this.log);
      for (const s of services.slice(3)) await start(s);
      const port = sandboxPort(await run(this.bin,['port',this.prefix + '-frontend','8080/tcp']));
      const url = `http://127.0.0.1:${port}`;
      for (let i=0;i<90;i++) {
        try {
          const r = await fetch(url + '/api/method/ping',{signal:AbortSignal.timeout(2000)});
          if (r.ok && (await r.json() as {message?:string}).message === 'pong') return url;
        } catch { /* startup */ }
        await new Promise(resolve => setTimeout(resolve,1000));
      }
      throw new Error('ERPNext is still starting. Reopen the course to retry; your work is saved.');
    } catch (error) { await this.stop(); throw error; }
    finally { await rm(secrets,{recursive:true,force:true}); }
  }
  async stop() {
    const existing=await run(this.bin,['ps','--all','--filter','label=ai.dhimant.browser='+this.key,'--format','{{.Names}}']);
    const names=existing.split(/\r?\n/).filter(name=>this.names.includes(name));
    if (names.length) await run(this.bin,['stop','--time','3',...names],60000);
  }
  async revoke(learner:string) {
    if(!/^[a-f0-9]{20}$/.test(learner))return;
    await run(this.bin,['exec',this.prefix+'-backend','env/bin/python','/opt/dhimantai/logout.py',learner]).catch(()=>undefined);
  }
  async shutdown() { await stopCourseRuntime(this.bin,[]); }
}
