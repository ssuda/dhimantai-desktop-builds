import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

test('reader aligns partial pages and preserves chapter boundaries and other reading directions',async()=>{
  const window:any={addEventListener(){}};
  const bridge:any={window};
  runInNewContext(readFileSync(resolve(__dirname,'../../../../assets/epub_reader/reader_bridge.js'),'utf8'),bridge);
  const container={scrollLeft:250,scrollWidth:2000,clientWidth:1000};
  let next=0,previous=0,reports=0;
  const manager={isPaginated:true,settings:{axis:'horizontal',direction:'ltr'},layout:{delta:1000},container,
    scrollTo:(x:number)=>{container.scrollLeft=x;},next:()=>{next++;},prev:()=>{previous++;}};
  const reader={manager,q:{enqueue:async(fn:()=>unknown)=>{await fn();}},reportLocation(){reports++;},destroy(){}};
  bridge.activateReader(null,reader);
  await window.epubControls.nextPage();assert.equal(container.scrollLeft,1000);assert.equal(next,0);
  await window.epubControls.prevPage();assert.equal(container.scrollLeft,0);assert.equal(previous,0);
  container.scrollLeft=750;await window.epubControls.prevPage();assert.equal(container.scrollLeft,0);
  await window.epubControls.prevPage();assert.equal(previous,1,'first page delegates to the preceding chapter');
  container.scrollLeft=1000;await window.epubControls.nextPage();assert.equal(next,1,'last page delegates to the next chapter');
  manager.settings.direction='rtl';await window.epubControls.nextPage();assert.equal(next,2);
  manager.settings.direction='ltr';manager.settings.axis='vertical';await window.epubControls.prevPage();assert.equal(previous,2);
  assert.equal(reports,7);
  let pending:()=>unknown=()=>{};
  reader.q.enqueue=async fn=>{pending=fn;};
  const turning=window.epubControls.nextPage();window.epubControls.destroy();await pending();await turning;
  assert.equal(next,2,'a queued turn cannot navigate a disposed book');
  assert.equal(reports,7,'a disposed book cannot report a position');
});
