import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {plan} from '../src/localRunner';
import {entryFile, LANGUAGE_EXTENSIONS} from '../src/learning';
import {scaffold} from '../src/cellLayout';
import {courseExamples, verifyCourseLanguage, readyMessage} from '../src/courseReadiness';
import {practiceIpynb} from '../src/practiceIpynb';
import {COURSE_LANGUAGES} from '../src/courseRecipe';

test('C++ notebooks keep native C++ files, language, and compiler', () => {
  assert.equal(entryFile('cpp'), 'main.cpp');
  assert.equal(scaffold('cpp', 'int main() {}').main, 'main.cpp');
  assert.ok(COURSE_LANGUAGES.includes('cpp'));
  assert.equal(LANGUAGE_EXTENSIONS.cpp?.id, 'ms-vscode.cpptools');
  const compiler = plan('cpp').compile!;
  assert.equal(compiler.tool, 'cxx');
  assert.ok(compiler.args.includes('-std=c++17'));
  assert.ok(compiler.args.includes('main.cpp'));
  const nb = practiceIpynb({id:'q', language:'cpp', question:'Print seven', starter:'#include <iostream>\nint main() {}',
    title:'C++', assistance:true, path:'/practice-code/q/notebook-coach', account:'a', tests:[]}, 'staging');
  assert.equal(nb.metadata.kernelspec.language, 'cpp');
});

test('C++ readiness executes the C++ program and reports compiler failure', async () => {
  assert.match(courseExamples.cpp, /std::cout/);
  const good={status:'exited',exit_code:0,stdout:readyMessage+'\n',stderr:'',command:'./main',duration_seconds:0,truncated:false};
  await verifyCourseLanguage({run:async(language,input)=>{
    assert.equal(language,'cpp'); assert.equal(input.source,courseExamples.cpp); return good;
  }},'cpp');
  await assert.rejects(verifyCourseLanguage({run:async()=>({...good,status:'compile_error',exit_code:1})},'cpp'),/course check failed/);
});
