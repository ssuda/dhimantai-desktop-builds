import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {join} from 'node:path';
import {Replayer} from '../src/apps/replay';

test('closing the studio cancels a waiting replay without touching further fields',async()=>{
 const abort=new AbortController();let calls=0;
 const replay=new Replayer({} as any,'page',{} as any,{} as any,'author','tag',join(__dirname,'../../media/browser/player'),async()=>{},
   async<T>()=>{calls++;abort.abort(new Error('Studio closed'));return false as T;},abort.signal);
 await assert.rejects(replay.run([{id:'customer',doctype:'Customer',steps:[],expected:{}}]),/Studio closed/);
 assert.equal(calls,1);
});
test('a decision omitted from saved-record checks cannot pass rehearsal',async()=>{
 const replay=new Replayer({} as any,'page',{} as any,{} as any,'author','tag',join(__dirname,'../../media/browser/player')) as any;
 assert.equal(await replay.discriminates({steps:[{field:'customer_type',decide:true,value:'Company'}],expected:{}},'Customer','saved'),false);
});
