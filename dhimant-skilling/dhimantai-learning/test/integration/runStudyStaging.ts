/** Explicit live acceptance against staging, using the downloaded release's files. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { ENVIRONMENTS } from '../../src/environments';

async function main() {
  const release = process.env.DHIMANTAI_STUDY_RELEASE;
  const learner = process.env.DHIMANTAI_STUDY_LEARNER;
  const output = process.env.DHIMANTAI_UX_OUT;
  const executable = process.env.VSCODE_TEST_EXECUTABLE;
  const service = {...ENVIRONMENTS.staging,
    ...(process.env.DHIMANTAI_STUDY_API_URL ? {apiUrl:process.env.DHIMANTAI_STUDY_API_URL} : {})};
  if (!release || !learner || !output || !executable || !existsSync(join(release,'package.json')) || !existsSync(learner)) {
    throw new Error('Set DHIMANTAI_STUDY_RELEASE (extracted extension), DHIMANTAI_STUDY_LEARNER (private QA account file), DHIMANTAI_UX_OUT and VSCODE_TEST_EXECUTABLE.');
  }
  const profile = mkdtempSync(join(tmpdir(),'dhimantai-study-staging-'));
  mkdirSync(join(profile,'User'));
  mkdirSync(output,{recursive:true});
  writeFileSync(join(profile,'User/settings.json'),JSON.stringify({
    'dhimantai.environment':'staging','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,
  }));
  try { await runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:resolve(release),
    extensionTestsPath:resolve(__dirname,process.argv[2] || 'suiteStudyLive'),
    launchArgs:['--disable-extensions','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
      '--user-data-dir',profile,'--remote-debugging-port='+(process.env.DHIMANTAI_CDP_PORT || '9341'),'--window-size=1440,900'],
    extensionTestsEnv:{DHIMANTAI_TEST_ENVIRONMENT:JSON.stringify(service),
      DHIMANTAI_STUDY_QUIZ_REVIEW:process.env.DHIMANTAI_STUDY_QUIZ_REVIEW||'',DHIMANTAI_STUDY_COURSES:process.env.DHIMANTAI_STUDY_COURSES||'',DHIMANTAI_STUDY_ACTIONS:process.env.DHIMANTAI_STUDY_ACTIONS||'',DHIMANTAI_TEST_WELCOME:'0',DHIMANTAI_STUDY_LEARNER:resolve(learner),DHIMANTAI_UX_OUT:resolve(output),
      DHIMANTAI_CDP_PORT:process.env.DHIMANTAI_CDP_PORT || '9341'},
  });
  } finally { rmSync(profile,{recursive:true,force:true}); }
  const report=JSON.parse(readFileSync(join(output,'live-study.json'),'utf8'));
  console.log(JSON.stringify({passed:report.passed,courses:report.courses?.length,turns:report.turns?.length,
    source_checks:report.source_checks,
    calls:report.courses?.reduce((n:number,c:any)=>n+c.actions.length,0),report:join(output,'live-study.json')},null,2));
}
void main().catch(error=>{console.error(error.message);process.exitCode=1;});
