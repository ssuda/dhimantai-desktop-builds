#!/usr/bin/env node
// Synthetic devices only; physical hardware and real consent are not certified.
const {spawn} = require('node:child_process');
const {mkdtempSync,rmSync,readFileSync,existsSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const root=resolve(__dirname,'..'), executable=process.env.VSCODE_TEST_EXECUTABLE;
if(!executable || !existsSync(executable)) throw new Error('Set VSCODE_TEST_EXECUTABLE to the custom desktop native executable.');
const profile=mkdtempSync(join(tmpdir(),'dhimantai-devices-'));
const receipt=process.env.DHIMANTAI_TEST_RESULTS;
if(!receipt || existsSync(receipt)) throw new Error('Set DHIMANTAI_TEST_RESULTS to a new JSON file path.');
const port=process.env.DHIMANTAI_CDP_PORT || '9340';
if(!/^\d+$/.test(port) || +port<1024 || +port>65535) throw new Error('Invalid CDP port');
const child=spawn(executable,['--user-data-dir',profile,'--extensions-dir',join(profile,'extensions'),
  '--disable-extensions','--skip-welcome','--skip-release-notes','--disable-updates',
  '--use-inmemory-secretstorage',...(process.platform==='darwin'?['--use-mock-keychain']:[]),
  '--remote-debugging-port='+port,'--use-fake-device-for-media-stream',
  '--extensionDevelopmentPath='+root,'--extensionTestsPath='+join(root,'out/test/integration/suiteDesktopDevices.js')],
  {stdio:'inherit',env:{...process.env,DHIMANTAI_CDP_PORT:port,DHIMANTAI_TEST_WELCOME:'0',DHIMANTAI_TEST_COURSES:'0',DHIMANTAI_TEST_LEARNING_WORKSPACE:'0'}});
let killTimer;
const timer=setTimeout(()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);},120000);
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('close',code=>{
  clearTimeout(timer);clearTimeout(killTimer);
  try {
    if(code!==0 || !JSON.parse(readFileSync(receipt,'utf8')).passed) throw new Error('Native device check failed; inspect the receipt.');
    console.log('Passed synthetic native microphone/camera check:',receipt);
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:250});}
});
