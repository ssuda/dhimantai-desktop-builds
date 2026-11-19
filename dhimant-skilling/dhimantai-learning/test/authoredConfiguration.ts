/** Contract fixtures come from the same pure authoring serializer used by publication. */
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {CourseConfiguration,courseConfiguration} from '../src/courseConfiguration';
const cached=new Map<string,CourseConfiguration>();
export function authoredConfiguration(title:string):CourseConfiguration {
  if(!cached.has(title)) {
    const root=resolve(__dirname,'../../../..');
    const code="import sys,json;from pathlib import Path;root=Path(sys.argv[1]);sys.path[:0]=[str(root/'content/courses'),str(root/'agent')];from runtime_configuration import configuration;print(json.dumps(configuration(root,sys.argv[2])))";
    const value=JSON.parse(execFileSync('python3',['-c',code,root,title],{encoding:'utf8',maxBuffer:2_000_000}));
    cached.set(title,courseConfiguration(value,title));
  }
  return structuredClone(cached.get(title)!);
}
