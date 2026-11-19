import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

function fixture(response:unknown={user:{user_id:'student-account'}}) {
  const filename=resolve(__dirname,'../src/cloudCli.js'),require=createRequire(filename),exports:any={},calls:any[]=[];
  const spawn=(bin:string,args:string[],options:unknown)=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}});
    calls.push({bin,args,options});
    child.stdin.on('finish',()=>setImmediate(()=>{
      child.stdout.write(typeof response==='string'?response:JSON.stringify(response));
      child.stdout.end();child.stderr.end();child.emit('close',0);
    }));return child;
  };
  runInNewContext(readFileSync(filename,'utf8'),{exports,module:{exports},setTimeout,clearTimeout,process:{platform:'linux',env:{}},
    require:(id:string)=>id==='vscode'?{}:id==='node:child_process'?{spawn}:id==='./localRunner'?{which:(name:string)=>'/bin/'+name}:require(id)});
  return {cli:new exports.CloudCli('jarvis'),calls,exports};
}

test('Indian cloud CLI reuses its local account and rejects an account switch before mutations',async()=>{
  const f=fixture();
  assert.deepEqual(Array.from(f.exports.AVAILABLE_CLOUD_PROVIDERS),['jarvis','aws','gcp','azure']);
  assert.equal(await f.cli.authenticate(),'student-account');
  await assert.rejects(f.cli.requireAccount('someone-else'),/different cloud account/);
  for(const call of f.calls){
    assert.equal(call.bin,'/bin/jl');
    assert.deepEqual(Array.from(call.args),['status','--json']);
    assert.equal(call.options.shell,false);
  }
});

test('malformed provider responses fail without being treated as a connected runtime',async()=>{
  const f=fixture('not json');
  await assert.rejects(f.cli.run(['status','--json']),/unreadable CLI response/);
});
