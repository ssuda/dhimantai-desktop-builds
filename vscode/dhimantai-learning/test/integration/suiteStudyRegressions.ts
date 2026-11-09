import * as assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import {EMAIL, PASSWORD} from './contractServer';
import {connect} from './suiteStudy';

const pause = (ms=100) => new Promise(resolve=>setTimeout(resolve,ms));
export async function run() {
  const out=process.env.DHIMANTAI_UX_OUT || '/tmp/dhimantai-study-regressions';mkdirSync(out,{recursive:true});
  const ext=vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth}=await ext.activate();await auth.signInWithPassword(EMAIL,PASSWORD);
  const courses=JSON.parse(readFileSync(join(ext.extensionPath,'media/study/book_companions.json'),'utf8')).courses;
  const chapter=(title:string)=>courses.flatMap((c:any)=>c.chapters).find((c:any)=>c.title===title).id;
  const cdp=await connect();
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const snapshot=()=>ui(`d=>{
    const w=d.defaultView; if(!w.__observed){w.__observed=true;w.__errors=[];w.addEventListener('error',e=>w.__errors.push(e.message));w.addEventListener('unhandledrejection',e=>w.__errors.push(String(e.reason)));const bridge=w.DhimantStudyBridge;w.DhimantStudyBridge=event=>{if(event.event==='page_changed')w.__page=event;bridge(event);};}
    const f=d.querySelector('#viewer iframe'), doc=f?.contentDocument, container=d.querySelector('.epub-container');
    const bounds=d.querySelector('#viewer').getBoundingClientRect();
    const walker=doc?.createTreeWalker(doc.body,4);let n,text='';
    while(walker&&(n=walker.nextNode())){const range=doc.createRange();range.selectNodeContents(n);
      if(Array.from(range.getClientRects()).some(b=>b.width&&b.height&&b.right+f.getBoundingClientRect().left>bounds.left&&b.left+f.getBoundingClientRect().left<bounds.right&&b.bottom+f.getBoundingClientRect().top>bounds.top&&b.top+f.getBoundingClientRect().top<bounds.bottom))text+=n.textContent;}
    return {title:d.querySelector('#title').textContent,page:d.querySelector('#page').textContent,
      errors:w.__errors,font:d.querySelector('#font').value,ready:d.querySelector('#loading').style.display==='none',text,
      previous:d.querySelector('#previous').disabled,next:d.querySelector('#next').disabled,
      cfi:w.__page?.cfi,layout:container&&{style:container.style.cssText,scroll:container.scrollLeft,scrollTop:container.scrollTop,scrollWidth:container.scrollWidth,clientWidth:container.clientWidth,frame:f?.style.cssText}};}`);
  const until=async(test:(s:any)=>boolean,label:string)=>{let s;for(let i=0;i<300;i++){s=await snapshot();if(test(s))return s;await pause();}throw new Error(label+': '+JSON.stringify(s));};
  try {
    await vscode.commands.executeCommand('dhimantai.openStudy',chapter('Preserve the Machine Contract'));
    let first=await until(s=>s?.ready&&s.page?.startsWith('Page 1 of'),'open machine contract');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    await ui(`d=>{d.querySelector('#reading').style.marginRight='0.5px';return true;}`);await pause(900);first=await snapshot();
    // Selection/find/trackpad scrolling can leave the paginated container between boundaries.
    await ui(`d=>{const c=d.querySelector('.epub-container');c.scrollLeft=c.clientWidth/4;return true;}`);await pause(300);
    await ui(`d=>{d.querySelector('#next').click();return true;}`);await pause(1000);
    writeFileSync(join(out,'navigation.json'),JSON.stringify({first,after:await snapshot()},null,2));
    const second=await until(s=>s?.page?.startsWith('Page 2 of'),'B4 next advances');
    assert.notEqual(second.cfi,first.cfi);assert.notEqual(second.text,first.text,'visible content changes');
    let last=second;
    while(!last.next){const previous=last.page;await ui(`d=>{d.querySelector('#next').click();return true;}`);last=await until(s=>s?.page!==previous,'advance to final page');}
    assert.match(last.page,/Page (\d+) of \1$/,'Next disabled on last page');
    while((await snapshot()).page!==second.page){await ui(`d=>{d.querySelector('#previous').click();return true;}`);await pause(300);}
    await ui(`d=>{d.querySelector('#previous').click();return true;}`);
    await until(s=>s?.page===first.page&&s.text===first.text&&s.previous,'B4 previous returns to first page');
    for(let repeat=0;repeat<3;repeat++) {
      await ui(`d=>{const c=d.querySelector('.epub-container');c.scrollLeft=c.clientWidth/4;return true;}`);await pause(100);
      await ui(`d=>{d.querySelector('#next').click();return true;}`);
      await until(s=>s?.page===second.page&&s.text===second.text,'repeated Next aligns the reader');
      await ui(`d=>{d.querySelector('#previous').click();return true;}`);
      await until(s=>s?.page===first.page&&s.text===first.text,'repeated Previous returns to the beginning');
    }
    await vscode.commands.executeCommand('dhimantai.openStudy',chapter('Protect an Abstraction Barrier'));
    await until(s=>s?.ready&&s.title==='Protect an Abstraction Barrier','open SICP');
    await ui(`d=>{const f=d.querySelector('#font');f.value='125%';f.dispatchEvent(new Event('change'));return true;}`);await pause(700);
    await ui(`d=>{d.querySelector('#next').click();return true;}`);
    const saved=await until(s=>s?.font==='125%'&&s.page?.startsWith('Page 2 of'),'move SICP to page 2');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('dhimantai.openStudy');
    await until(s=>s?.ready&&s.title===saved.title&&s.font===saved.font&&s.page===saved.page&&s.cfi===saved.cfi,'B6 no-argument reopen restores chapter, text size and position');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,'restored.png'),Buffer.from(shot.data,'base64'));
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,first,second,saved,restored:await snapshot()},null,2));
  } catch(error) {
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error),snapshot:await snapshot()},null,2));throw error;
  } finally {cdp.close();}
}
