/** Runtime releases come from the entitled course API; notebooks cannot provide image URLs or Compose files. */
export interface RuntimeSelection {image: string; compose?: string}
export interface RuntimeRelease {
  version: 1; course_id: string; title: string; source_sha256: string;
  recipe: {language: string; services: string[]; imports?: string[]; torch?: string; labs?: boolean};
  images: Record<string, string>; default: RuntimeSelection;
  lessons: Record<string, RuntimeSelection>; labs: Record<string, RuntimeSelection>;
  composes: Record<string, {default_service: string; compose: {services: Record<string, any>; networks?: Record<string, any>; volumes?: Record<string, any>}}>;
}
const pin = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$/;
const name = /^[a-z][a-z0-9-]{0,62}$/;
export function runtimeRelease(value: unknown): RuntimeRelease {
  const r = value as RuntimeRelease;
  if (!r || r.version !== 1 || !name.test(r.course_id) || !/^[a-f0-9]{64}$/.test(r.source_sha256)
      || !r.recipe || !r.images || !r.lessons || !r.labs || !r.composes) throw new Error('Invalid published course runtime.');
  const images = Object.values(r.images);
  if (!images.length || images.some(v => typeof v !== 'string' || !pin.test(v))) throw new Error('The course image needs a verified digest.');
  for (const s of [r.default, ...Object.values(r.lessons), ...Object.values(r.labs)])
    if (!s || !images.includes(s.image) || (s.compose && !r.composes[s.compose])) throw new Error('Unknown course image or lab.');
  for (const topology of Object.values(r.composes)) {
    if (!topology.compose?.services?.[topology.default_service]) throw new Error('The lab has no default machine.');
    const c = topology.compose;
    if (Object.keys(c).some(k => !['services', 'networks', 'volumes'].includes(k))) throw new Error('Unsupported lab topology.');
    for (const [id,s] of Object.entries(c.services)) {
      if (!name.test(id) || !images.includes(s.image)
          || Object.keys(s).some(k => !['image','command','entrypoint','environment','depends_on','healthcheck','networks','volumes','hostname','mem_limit','cpus','pids_limit'].includes(k))
          || !s.mem_limit || !s.cpus || !s.pids_limit || /\$(?:\{|[A-Za-z_])/.test(JSON.stringify(s).replaceAll('$$',''))) throw new Error('Unsupported lab machine configuration.');
      if ((s.volumes ?? []).some((v:unknown) => typeof v !== 'string' || !/^[a-z][a-z0-9-]*:\/[a-zA-Z0-9_./-]+(?::ro)?$/.test(v)
          || !Object.hasOwn(c.volumes ?? {}, v.split(':')[0]))) throw new Error('Lab volumes must belong to this lab.');
      for (const key of ['command','entrypoint'])
        if (s[key] !== undefined && (!Array.isArray(s[key]) || !s[key].length || s[key].some((arg:unknown) => typeof arg !== 'string')))
          throw new Error('Lab commands must use argument lists.');
      if (s.environment && (typeof s.environment !== 'object' || Array.isArray(s.environment))) throw new Error('Invalid lab environment.');
    }
    for (const [id,v] of Object.entries(c.volumes ?? {}))
      if (!name.test(id) || !v || Object.keys(v).length) throw new Error('External lab volumes are unsupported.');
    for (const [id,n] of Object.entries(c.networks ?? {}))
      if (!name.test(id) || !n || Object.keys(n).some(k => k !== 'internal')) throw new Error('External lab networks are unsupported.');
  }
  return r;
}
export function runtimeSelection(release:RuntimeRelease, target?:{lesson?:string; lab?:string}) {
  return (target?.lab && release.labs[target.lab]) || (target?.lesson && release.lessons[target.lesson]) || release.default;
}
export function runtimeMachines(release:RuntimeRelease, selection:RuntimeSelection):string[] {
  return selection.compose ? Object.keys(release.composes[selection.compose].compose.services) : ['course'];
}
export function composeRuntime(release:RuntimeRelease, selection:RuntimeSelection, root:string, key:string, uid:number, gid:number, platform:NodeJS.Platform=process.platform) {
  if (!selection.compose) throw new Error('This lesson uses one course container.');
  const value = JSON.parse(JSON.stringify(release.composes[selection.compose].compose));
  for (const [id,service] of Object.entries(value.services) as [string,any][]) {
    service.labels = {'ai.dhimant.course':key, 'ai.dhimant.recipe':release.source_sha256, 'ai.dhimant.machine':id};
    service.environment = {...service.environment, HOME:'/course/.home/' + selection.compose + '/' + id, SHELL:'/bin/zsh'};
    // Bootstrap the mapped identity before the authored service starts, then drop to the learner UID.
    service.entrypoint = ['python','/opt/dhimantai/service.py',String(uid),String(gid),...(service.entrypoint ?? [])];
    service.command ??= ['sleep','infinity'];
    service.user = '0:0';
    service.working_dir = '/course';
    if (platform === 'linux') service.userns_mode = 'keep-id';
    service.volumes = [...(service.volumes ?? []), {type:'bind',source:root.replaceAll('$',()=>'$$'),target:'/course',
      ...(platform === 'linux' ? {bind:{selinux:'z'}} : {})}];
  }
  return value;
}
