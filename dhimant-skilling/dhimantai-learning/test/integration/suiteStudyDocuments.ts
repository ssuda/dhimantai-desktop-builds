import * as assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import {EMAIL,PASSWORD} from './contractServer';
import {connect} from './suiteStudy';
import {pdfId,epubId} from './studyDocuments';
const pause=(ms=100)=>new Promise(r=>setTimeout(r,ms));
export async function run(){
  const out=process.env.DHIMANTAI_UX_OUT||'/tmp/dhimantai-study-documents';mkdirSync(out,{recursive:true});
  const ext=vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth}=await ext.activate();await auth.signInWithPassword(EMAIL,PASSWORD);
  const cdp=await connect(),results:any[]=[];
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const snapshot=()=>ui(`d=>{
    const w=d.defaultView;if(!w.__observed){w.__observed=true;w.__errors=[];const log=w.console.error;w.console.error=(...args)=>{w.__errors.push(args.map(String).join(' '));log(...args);};w.addEventListener('error',e=>w.__errors.push(e.message));w.addEventListener('unhandledrejection',e=>w.__errors.push(String(e.reason)));const bridge=w.DhimantStudyBridge;w.DhimantStudyBridge=e=>{if(e.event==='page_changed')w.__page=e;bridge(e);};}
    const f=d.querySelector('#viewer iframe'),doc=f?.contentDocument,bounds=d.querySelector('#viewer').getBoundingClientRect(),fr=f?.getBoundingClientRect();
    const walker=doc?.createTreeWalker(doc.body,4);let n,text='';while(walker&&(n=walker.nextNode())){const r=doc.createRange();r.selectNodeContents(n);if(Array.from(r.getClientRects()).some(b=>b.width&&b.height&&b.right+fr.left>bounds.left&&b.left+fr.left<bounds.right&&b.bottom+fr.top>bounds.top&&b.top+fr.top<bounds.bottom))text+=n.textContent;}
    const images=Array.from(doc?.images||[]).filter(i=>{const b=i.getBoundingClientRect();return i.complete&&i.naturalWidth&&b.width&&b.height&&b.right+fr.left>bounds.left&&b.left+fr.left<bounds.right&&b.bottom+fr.top>bounds.top&&b.top+fr.top<bounds.bottom;}).length;
    return {title:d.querySelector('#title').textContent,page:d.querySelector('#page').textContent,cfi:w.__page?.cfi,ready:d.querySelector('#loading').style.display==='none',error:d.querySelector('#loading-text').textContent,text,images,metadata:/source_pages|image_guide|EXERCISE:END|cosolve:/.test(doc?.body.textContent||''),previous:d.querySelector('#previous').disabled,next:d.querySelector('#next').disabled,errors:w.__errors,frame:!!f};}`);
  const until=async(test:(s:any)=>boolean,label:string)=>{let s;for(let i=0;i<200;i++){s=await snapshot();if(test(s))return s;await pause();}throw new Error(label+': '+JSON.stringify(s));};
  const visible=(s:any)=>s?.ready&&(s.text.trim().length>0||s.images>0);
  try{
    for(const [id,format] of [[pdfId,'PDF'],[epubId,'EPUB']]){
      await vscode.commands.executeCommand('dhimantai.openStudy',id);
      const first=await until(s=>visible(s)&&s.title.endsWith('('+format+')')&&s.page.startsWith('Page 1 of'),'open '+format);
      assert.equal(first.metadata,false);
      await ui(`d=>{d.querySelector('#next').click();return true;}`);
      const second=await until(s=>visible(s)&&s.page.startsWith('Page 2 of'),'Next '+format);assert.notEqual(second.cfi,first.cfi);
      await ui(`d=>{d.querySelector('#previous').click();return true;}`);
      await until(s=>visible(s)&&s.page.startsWith('Page 1 of'),'Back '+format);
      for(let round=0;round<3;round++){
        await ui(`d=>{d.querySelector('#next').click();d.querySelector('#next').click();d.querySelector('#previous').click();return true;}`);await pause(500);
        await until(visible,'rapid navigation '+format);
        for(const [width,height] of [[560,600],[1920,1080],[1100,800]]){
          await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await pause(700);
          await until(visible,'resize '+format+' '+width);
        }
        await ui(`d=>{d.querySelector('#open-study').click();d.querySelector('#close-study').click();return true;}`);
        await until(visible,'Back to book '+format);
      }
      await vscode.commands.executeCommand('dhimantai.courseCatalog');await pause(300);
      await vscode.commands.executeCommand('dhimantai.openStudy');await until(visible,'reveal '+format);
      await pause(500);const saved=await snapshot();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('dhimantai.openStudy');
      const restored=await until(s=>visible(s)&&s.cfi===saved.cfi,'restore '+format);
      assert.deepEqual(restored.errors,[]);results.push({format,first,second,saved,restored});
      if(format==='PDF'){
        const outer=await cdp.evaluate(`Array.from(document.querySelectorAll('iframe')).map(f=>f.getBoundingClientRect().toJSON()).find(r=>r.width>500&&r.height>400)`);
        const rect=await ui(`d=>{const f=d.querySelector('#viewer iframe'),a=f.getBoundingClientRect(),b=f.contentDocument.querySelector('img').getBoundingClientRect();d.querySelector('#crop').click();return {left:a.left+b.left,top:a.top+b.top,width:b.width};}`);
        // Start below the floating crop instructions, then drag up across text.
        const x=outer.left+rect.left+10,y=outer.top+rect.top+155;
        await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+rect.width-20,y:y-140,button:'left',buttons:1});
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+rect.width-20,y:y-140,button:'left',clickCount:1});
        await ui(`d=>{d.querySelector('#apply-crop').click();return true;}`);
        let ink=0;for(let i=0;i<100&&!ink;i++){ink=await ui(`async d=>{if(d.querySelector('#crop-toolbar').hidden)return 0;const img=d.querySelector('#crop-preview');await img.decode();const c=d.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const pixels=x.getImageData(0,0,c.width,c.height).data;let ink=0;for(let i=0;i<pixels.length;i+=4)if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<100)ink++;return ink;}`);await pause();}
        const captured=await ui(`d=>({image:d.querySelector('#crop-preview').src,status:d.querySelector('#crop-status').textContent,hidden:d.querySelector('#crop-toolbar').hidden})`);
        if(captured.image.startsWith('data:image/png;base64,'))writeFileSync(join(out,'pdf-crop.png'),Buffer.from(captured.image.split(',')[1],'base64'));
        assert.ok(ink>100,'PDF crop includes the actual printed text: '+JSON.stringify({ink,status:captured.status,hidden:captured.hidden,rect,outer}));
        await ui(`d=>{d.querySelector('#dismiss-crop').click();return true;}`);
      }
      writeFileSync(join(out,format.toLowerCase()+'.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await vscode.commands.executeCommand('dhimantai.openStudy','markdown-only-missing');
    await until(s=>!s.frame&&/No PDF or EPUB/.test(s.error),'missing-document empty state');
    await auth.signOut();await until(s=>!s.frame&&/Sign in/.test(s.error),'sign out removes book');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,results},null,2));
  }catch(error){writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error),snapshot:await snapshot(),results},null,2));throw error;}
  finally{cdp.close();}
}
