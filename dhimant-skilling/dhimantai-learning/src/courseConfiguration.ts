import type {InstructorTerminal} from './notebookTerminal';
import type {EditorTool} from './courseEditorTools';
import {createHash} from 'node:crypto';
import {courseRecipe, COURSE_LANGUAGES, Recipe} from './courseRecipe';
import type {GpuLabRequirement} from './sshRuntimeConfig';
import type {About} from './dataLab';
import type {RuntimeRelease} from './courseRuntime';

export interface CourseConfiguration {
  version:1; title:string; recipe:Recipe & {language:string;services:string[]};
  preferred_accelerator:'gpu'|'tpu'|null;
  external_guidance?:string|null;
  compute:{default:Record<string,unknown>|null;labs:Record<string,Record<string,unknown>|null>};
  gpu:{default:GpuLabRequirement|null;labs:Record<string,GpuLabRequirement|null>};
  datasets:Record<string,{sql:string;sha256:string;about:About}>;
  scenarios:{version:1;scenarios:{id:string;setup:string;setup_sha256:string}[]};
  ports:{port:number;protocol:'tcp'|'udp'}[];
  editor_extensions?:EditorTool[];
  instructor_terminal?:InstructorTerminal;
  notebooks?:{id:string;name:string}[];
}
export interface CourseRuntimeResponse {runtime:RuntimeRelease|null;configuration:CourseConfiguration}
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
export function courseConfiguration(value:unknown,title:string):CourseConfiguration {
  const c=value as CourseConfiguration;
  if(!c||c.version!==1||typeof c.title!=='string'||c.title.toLowerCase()!==title.toLowerCase()
      ||JSON.stringify(c).length>2_000_000||!c.recipe||!c.compute?.labs||!c.gpu?.labs||!c.datasets
      ||!c.scenarios||c.scenarios.version!==1||!Array.isArray(c.scenarios.scenarios)
      ||![null,'gpu','tpu'].includes(c.preferred_accelerator)||!Array.isArray(c.ports)||c.ports.length>8)
    throw new Error('The service returned invalid course configuration. Republish the course configuration.');
  const terminal = c.instructor_terminal;
  if (terminal !== undefined && (!terminal || !['zsh','postgres','db2'].includes(terminal.kind)
      || typeof terminal.auto_open !== 'boolean' || terminal.kind === 'postgres' && c.recipe.language !== 'pglab'))
    throw new Error('Invalid Instructor terminal.');
  courseRecipe({[title.toLowerCase()]:c.recipe},title);
  if(!COURSE_LANGUAGES.includes(c.recipe.language)||[...(c.recipe.languages??[])].some(l=>!COURSE_LANGUAGES.includes(l)))throw new Error('Invalid course language.');
  for(const key of ['services','languages','requirements','imports','data'] as const) {
    const entries=c.recipe[key];
    if(entries!==undefined&&(!Array.isArray(entries)||entries.length>256||entries.some(s=>typeof s!=='string'||s.length>500||s.includes('\n'))))throw new Error('Invalid course recipe entries.');
  }
  if(c.external_guidance!==undefined&&c.external_guidance!==null&&(typeof c.external_guidance!=='string'||c.external_guidance.length>20_000))throw new Error('Invalid course guidance.');
  for(const lab of [c.compute.default,...Object.values(c.compute.labs)])if(lab!==null) {
    if(!lab||['nodes','gpusPerNode','totalGpus'].some(k=>!Number.isInteger(lab[k])||Number(lab[k])<0)||Number(lab.nodes)*Number(lab.gpusPerNode)!==lab.totalGpus)throw new Error('Invalid course compute requirements.');
  }
  for(const lab of [c.gpu.default,...Object.values(c.gpu.labs)])if(lab!==null) {
    if(!lab||lab.version!==1||!['inference-nvidia-v1','gpu-python-v1'].includes(lab.recipe)||[lab.nodes,lab.gpusPerNode].some(n=>!Number.isInteger(n)||n<1||n>8))throw new Error('Invalid GPU runtime requirements.');
  }
  if(c.notebooks!==undefined&&(!Array.isArray(c.notebooks)||c.notebooks.length>256||c.notebooks.some(n=>!n||!/^[A-Za-z0-9_-]{1,128}$/.test(n.id)||!/^\d{2,3}-[a-z0-9-]{1,70}\.ipynb$/.test(n.name))||new Set(c.notebooks.map(n=>n.name)).size!==c.notebooks.length||new Set(c.notebooks.map(n=>n.id)).size!==c.notebooks.length))throw new Error('Invalid downloadable notebooks.');
  for(const [name,d] of Object.entries(c.datasets))
    if(!/^[a-z][a-z0-9_]{0,31}$/.test(name)||typeof d.sql!=='string'||sha(d.sql)!==d.sha256||!d.about)
      throw new Error('The course dataset checksum differs.');
  if(JSON.stringify([...(c.recipe.data??[])].sort())!==JSON.stringify(Object.keys(c.datasets).sort()))throw new Error('Course datasets differ from their declaration.');
  for(const s of c.scenarios.scenarios)if(typeof s.setup!=='string'||sha(s.setup)!==s.setup_sha256)throw new Error('The course scenario checksum differs.');
  for(const p of c.ports)if(!Number.isInteger(p.port)||p.port<1024||p.port>65535||!['tcp','udp'].includes(p.protocol))throw new Error('Invalid course preview port.');
  return c;
}
