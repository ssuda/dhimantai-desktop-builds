import * as assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import {Api} from '../../src/api';
import {EMAIL,PASSWORD} from './contractServer';
import {connect} from './suiteStudy';
const pause=(ms=150)=>new Promise(r=>setTimeout(r,ms));
export async function run(){
  const out=process.env.DHIMANTAI_UX_OUT||'/tmp/dhimantai-study-crop';mkdirSync(out,{recursive:true});
  const {auth}=await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const cdp=await connect();
  const originalGrant=Api.prototype.learningRoom;
  Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'local-fixture'});
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const until=async(expression:string,label:string)=>{for(let i=0;i<200;i++){const v=await ui(expression);if(v)return v;await pause();}throw new Error('Timed out '+label+': '+JSON.stringify(await ui(`d=>({crop:d.querySelector('#crop-status').textContent,loading:d.querySelector('#loading-text').textContent,loadingDisplay:d.querySelector('#loading').style.display,disabled:d.querySelector('#crop').disabled,title:d.querySelector('#title').textContent,frames:Array.from(d.querySelectorAll('#viewer iframe')).map(f=>({state:f.contentDocument?.readyState,text:f.contentDocument?.body?.textContent?.slice(0,100)}))})`)));};
  const capture=async(name:string)=>{
    writeFileSync(join(out,name+'-source.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    writeFileSync(join(out,name+'-geometry.json'),JSON.stringify(await ui(`d=>{const f=d.querySelector('#viewer iframe'),b=f.contentDocument.body,h=f.contentDocument.documentElement;const r=e=>({rect:e.getBoundingClientRect().toJSON(),inline:e.getAttribute('style'),width:e.clientWidth,height:e.clientHeight,scrollX:e.scrollLeft});return {frame:r(f),body:r(b),html:r(h),viewer:r(d.querySelector('#viewer')),page:d.querySelector('#page').textContent,window:{x:f.contentWindow.scrollX,y:f.contentWindow.scrollY},bodyStyle:{width:f.contentWindow.getComputedStyle(b).width,columnWidth:f.contentWindow.getComputedStyle(b).columnWidth,columnGap:f.contentWindow.getComputedStyle(b).columnGap}};}`),null,2));
    await ui(`d=>{d.querySelector('#crop').click();const o=d.querySelector('#crop-overlay');o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));for(let i=0;i<25;i++)o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));return true;}`);
    writeFileSync(join(out,name+'-selection.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await ui(`d=>{d.querySelector('#crop-overlay').dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;}`);
    await until(`d=>!d.querySelector('#crop-toolbar').hidden`,'crop preview');
    const data=await ui(`d=>d.querySelector('#crop-preview').src`);
    assert.match(data,/^data:image\/png;base64,/);assert.ok(data.length>1000,'crop has rendered content');
    writeFileSync(join(out,name+'.png'),Buffer.from(data.split(',')[1],'base64'));
    const ink=await ui(`async d=>{const img=d.querySelector('#crop-preview');await img.decode();const c=d.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const pixels=x.getImageData(0,0,c.width,c.height).data;let ink=0;for(let i=0;i<pixels.length;i+=4)if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<200)ink++;return ink;}`);
    assert.ok(ink>1000,'crop must include visible content, not a blank later page: '+ink);
    assert.equal(await ui(`d=>d.querySelector('#study-dialog').open`),false,'crop preview stays on the book');
    return data;
  };
  try{
    await vscode.commands.executeCommand('dhimantai.openStudy','book-zen-assembly');
    await until(`d=>d.querySelector('#loading').style.display==='none'&&!d.querySelector('#crop').disabled`,'reader ready');await pause(500);
    assert.equal(await ui(`d=>d.querySelector('#viewer iframe').contentDocument.compatMode`),'CSS1Compat','math uses standards layout');
    const outer=await cdp.evaluate(`Array.from(document.querySelectorAll('iframe')).map(f=>f.getBoundingClientRect().toJSON()).find(r=>r.width>500&&r.height>400)`);
    assert.ok(outer,'visible workbench webview');
    await ui(`d=>{d.querySelector('#crop').click();return true;}`);
    const bounds=await ui(`d=>d.querySelector('#crop-overlay').getBoundingClientRect().toJSON()`);
    const x=outer.left+bounds.left+80,y=outer.top+bounds.top+180;
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+600,y:y+250,button:'left',buttons:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+600,y:y+250,button:'left',clickCount:1});
    assert.equal(await ui(`d=>!d.querySelector('#crop-overlay').hidden&&d.querySelector('#crop-toolbar').hidden&&!d.querySelector('#apply-crop').disabled`),true,'mouse release leaves the selection editable');
    const drag=async(selector:string,dx:number,dy:number)=>{
      const r=await ui(`d=>d.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
      const x=outer.left+r.left+r.width/2,y=outer.top+r.top+r.height/2;
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+dx,y:y+dy,button:'left',buttons:1});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+dx,y:y+dy,button:'left',clickCount:1});
    };
    await drag('#crop-box',30,20);await drag('[data-edge="e"]',40,0);await drag('[data-edge="nw"]',20,10);
    assert.deepEqual(await ui(`d=>{const s=d.querySelector('#crop-box').style;return ['left','top','width','height'].map(k=>parseFloat(s[k]));}`),[130,210,620,240]);
    writeFileSync(join(out,'adjusted-selection.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await ui(`d=>{d.querySelector('#apply-crop').click();return true;}`);
    await until(`d=>!d.querySelector('#crop-toolbar').hidden`,'apply adjusted crop');
    await until(`d=>d.querySelector('#crop-preview').naturalWidth>0`,'decoded crop preview');
    assert.deepEqual(await ui(`d=>({width:d.querySelector('#crop-preview').naturalWidth,height:d.querySelector('#crop-preview').naturalHeight})`),{width:1240,height:480});
    const adjusted=await ui(`d=>d.querySelector('#crop-preview').src`);
    writeFileSync(join(out,'adjusted-crop.png'),Buffer.from(adjusted.split(',')[1],'base64'));
    // Acknowledged local transport verifies the exact adjusted image is sent,
    // with no whole-page screenshot or extracted passage substituted.
    await ui(`d=>{const w=d.defaultView,peer={identity:'fixture',isAgent:true,trackPublications:new Map()};w.__cropCalls=[];
      class Room {remoteParticipants=new Map([['fixture',peer]]);on(){}async connect(){}async disconnect(){}registerTextStreamHandler(){}
        localParticipant={registerRpcMethod(){},performRpc:async r=>{if(r.method==='switch_mode')return 'ok';const p=JSON.parse(r.payload);w.__cropCalls.push({method:r.method,payload:p});return r.method==='study_selection_image'?JSON.stringify({status:'ok',selection_request_id:p.selection_request_id,index:p.index,complete:p.index===p.total-1}):'ok';}};
      }w.LivekitClient={...w.LivekitClient,Room};d.querySelector('#explain-crop').click();return true;}`);
    await until(`d=>d.defaultView.__cropCalls.some(c=>c.method==='explain_selection')`,'adjusted crop delivered');
    assert.equal(await ui(`d=>d.defaultView.__cropCalls.filter(c=>c.method==='study_selection_image').map(c=>c.payload.data).join('')`),adjusted);
    assert.equal(await ui(`d=>d.querySelector('#crop-reference-image').src`),adjusted);
    assert.equal(await ui(`d=>{const p=d.defaultView.__cropCalls.find(c=>c.method==='explain_selection').payload;return p.is_cropped_snippet===true&&!('selected_text' in p)&&p.selection_image_request_id===p.request_id;}`),true);
    await ui(`d=>{d.querySelector('#close-study').click();return true;}`);
    await ui(`d=>{d.querySelector('#dismiss-crop').click();return true;}`);
    const first=await capture('crop-page-1');
    writeFileSync(join(out,'crop-preview.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await ui(`d=>{d.querySelector('#next').click();return true;}`);await pause(500);
    assert.equal(await ui(`d=>d.querySelector('#crop-toolbar').hidden&&!d.querySelector('#crop-preview').hasAttribute('src')`),true,'page navigation discards old image bytes');
    const second=await capture('crop-page-2');assert.notEqual(first,second,'second-page crop contains a different page');
    await ui(`d=>{d.querySelector('#dismiss-crop').click();d.querySelector('#crop').click();d.querySelector('#crop-overlay').dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'Escape'}));return true;}`);
    assert.equal(await ui(`d=>d.querySelector('#crop-overlay').hidden&&d.querySelector('#crop-toolbar').hidden`),true,'Escape cancels crop');
    // A local graphics fixture exercises raster, SVG, and the existing KaTeX font CSS.
    // It is never sent to an AI or represented as an authored companion chapter.
    await ui(`d=>{d.querySelector('#previous').click();return true;}`);await pause(500);
    await ui(`d=>{const f=d.querySelector('#viewer iframe').contentDocument;const card=f.createElement('div');card.id='crop-fixture';card.style.cssText='position:fixed;left:80px;top:160px;width:500px;height:250px;background:white;color:black;z-index:1000;line-height:1.3';card.innerHTML=${JSON.stringify('<h2>Visual crop fixture</h2><svg xmlns="http://www.w3.org/2000/svg" width="160" height="85"><rect width="160" height="85" fill="#255ac4"/><circle cx="80" cy="42" r="30" fill="#ffc83d"/></svg><img width="80" height="80" alt="Raster square">'+require('katex').renderToString('x^2 + \\frac{1}{2} = 7'))};const c=f.createElement('canvas');c.width=c.height=80;const x=c.getContext('2d');x.fillStyle='#c82d62';x.fillRect(0,0,80,80);card.querySelector('img').src=c.toDataURL();f.body.append(card);return true;}`);await pause(500);
    writeFileSync(join(out,'math-layout.json'),JSON.stringify(await ui(`d=>{const f=d.querySelector('#viewer iframe').contentDocument;return {mode:f.compatMode,type:f.contentType,math:f.querySelector('.katex').outerHTML,nodes:Array.from(f.querySelectorAll('.katex .vlist,.katex .vlist>span,.katex .frac-line')).map(e=>({class:e.className,style:e.getAttribute('style'),rect:e.getBoundingClientRect().toJSON(),position:f.defaultView.getComputedStyle(e).position,top:f.defaultView.getComputedStyle(e).top,display:f.defaultView.getComputedStyle(e).display}))};}`),null,2));
    await capture('crop-graphics');
    assert.equal(await ui(`d=>{const f=d.querySelector('#viewer iframe').contentDocument;return f.defaultView.getComputedStyle(f.querySelector('.katex .vlist>span')).position;}`),'relative','fraction child-combinator CSS survives EPUB serialization');
    const colors=await ui(`async d=>{const img=d.querySelector('#crop-preview');await img.decode();const c=d.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const p=x.getImageData(0,0,c.width,c.height).data;let blue=0,yellow=0,pink=0;for(let i=0;i<p.length;i+=4){if(p[i]===37&&p[i+1]===90&&p[i+2]===196)blue++;if(p[i]===255&&p[i+1]===200&&p[i+2]===61)yellow++;if(p[i]===200&&p[i+1]===45&&p[i+2]===98)pink++;}return {blue,yellow,pink};}`);
    assert.ok(colors.blue>1000&&colors.yellow>1000&&colors.pink>1000,'SVG and raster pixels are actually included: '+JSON.stringify(colors));
    await ui(`d=>{d.querySelector('#dismiss-crop').click();const img=d.querySelector('#viewer iframe').contentDocument.querySelector('#crop-fixture img');img.src='data:image/png;base64,broken';return true;}`);await pause(300);
    await ui(`d=>{d.querySelector('#crop').click();const o=d.querySelector('#crop-overlay');o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'ArrowRight'}));o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'Enter'}));return true;}`);
    await until(`d=>d.querySelector('#crop-status').textContent.includes('Wait for the picture')`,'missing image blocks capture');
    assert.equal(await ui(`d=>d.querySelector('#crop-toolbar').hidden`),true,'missing picture never creates a partial crop');
    await auth.signOut();await until(`d=>d.querySelector('#crop').disabled&&d.querySelector('#crop-overlay').hidden`,'signout clears crop');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,checks:['real EPUB image capture','different paginated crops','SVG and raster and math-font fixture','missing-image failure','real mouse draw/move/edge/corner resize','explicit apply','exact adjusted image uploaded through acknowledged fixture transport','keyboard selection/cancel','standards-mode KaTeX fraction layout','page change discards image','signout clears selection','preview without side panel'],output:out},null,2));
  }catch(error){writeFileSync(join(out,'failure.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error)},null,2));throw error;}
  finally{Api.prototype.learningRoom=originalGrant;cdp.close();}
}
