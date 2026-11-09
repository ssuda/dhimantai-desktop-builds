import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {StudyCropSelector,uploadStudyCrop} from '../webview/studyCrop';

const source={source_id:'book:example',revision:'revision'};
const image='data:image/png;base64,'+'a'.repeat(24000);
test('Study crop uses ordered, acknowledged Flutter image chunks with one source/request identity',async()=>{
  const calls:any[]=[];
  await uploadStudyCrop(image,'crop-1',source,async(method,payload:any)=>{
    calls.push({method,...payload});
    return JSON.stringify({status:'ok',selection_request_id:payload.selection_request_id,index:payload.index,complete:payload.index===payload.total-1});
  },()=>true);
  assert.equal(calls.length,3);assert.equal(calls.map(c=>c.data).join(''),image);
  for(const [index,call] of calls.entries()){
    assert.equal(call.method,'study_selection_image');assert.equal(call.index,index);assert.equal(call.total,3);
    assert.equal(call.source_id,source.source_id);assert.equal(call.revision,source.revision);
    assert.equal(call.request_id,'crop-1');assert.equal(call.selection_request_id,'crop-1');assert.ok(call.data.length<=10240);
  }
});
test('Study crop stops on malformed acknowledgements, cancellation and invalid/oversized images',async()=>{
  for(const reply of ['ok','{}',JSON.stringify({status:'ok',selection_request_id:'wrong',index:0,complete:false})]){
    let calls=0;
    await assert.rejects(uploadStudyCrop(image,'id',source,async()=>{calls++;return reply;},()=>true));assert.equal(calls,1);
  }
  let current=true,calls=0;
  await assert.rejects(uploadStudyCrop(image,'id',source,async()=>{calls++;current=false;return '{}';},()=>current),/changed/);
  assert.equal(calls,1);
  for(const data of ['https://example.com/picture.png','data:image/svg+xml;base64,abcd','data:image/png;base64,'+'a'.repeat(8*1024*1024)]){
    await assert.rejects(uploadStudyCrop(data,'id',source,async()=>{throw new Error('must not send');},()=>true),/Select the area again/);
  }
});

function selectionSurface(){
  const dom=new JSDOM('<button id="crop"></button><div id="overlay" hidden tabindex="0"><div class="crop-guidance"><button id="apply"></button><button id="cancel"></button></div><div id="box" hidden></div></div><p id="status"></p><div id="viewer"></div>');
  const w=dom.window,el=(id:string)=>w.document.getElementById(id)!,overlay=el('overlay'),box=el('box');
  overlay.getBoundingClientRect=()=>({left:20,top:40,width:800,height:600} as DOMRect);
  let captured:number|undefined;
  overlay.setPointerCapture=id=>{captured=id;};overlay.hasPointerCapture=id=>captured===id;overlay.releasePointerCapture=()=>{captured=undefined;};
  const selector=new StudyCropSelector({button:el('crop') as HTMLButtonElement,overlay,box,apply:el('apply') as HTMLButtonElement,cancel:el('cancel') as HTMLButtonElement,status:el('status'),viewer:el('viewer'),available:()=>true,image(){},changed(){}});
  // JSDOM has no native PointerEvent handler properties; forward dispatched events.
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])overlay.addEventListener(type,event=>(overlay as any)['on'+type]?.(event));
  const pointer=(target:HTMLElement,type:string,x:number,y:number,id=1)=>{
    const event=new w.MouseEvent(type,{bubbles:true,button:0,clientX:x+20,clientY:y+40});Object.defineProperty(event,'pointerId',{value:id});target.dispatchEvent(event);
  };
  const drag=(target:HTMLElement,x:number,y:number,endX:number,endY:number)=>{pointer(target,'pointerdown',x,y);pointer(overlay,'pointermove',endX,endY);pointer(overlay,'pointerup',endX,endY);};
  const rect=()=>['left','top','width','height'].map(k=>parseFloat(box.style.getPropertyValue(k)));
  const key=(key:string,shiftKey=false)=>overlay.dispatchEvent(new w.KeyboardEvent('keydown',{key,shiftKey,bubbles:true}));
  el('crop').click();
  return {dom,w,el,overlay,box,selector,pointer,drag,rect,key,captured:()=>captured};
}

test('Study crop remains adjustable, moves within the book and supports keyboard and cancellation',()=>{
  const s=selectionSurface();
  try{
    const {el,box,overlay,drag,rect,key}=s;
    assert.equal((el('apply') as HTMLButtonElement).disabled,true);
    drag(overlay,400,350,100,100);assert.deepEqual(rect(),[100,100,300,250]);
    assert.equal(overlay.hidden,false);assert.equal((el('apply') as HTMLButtonElement).disabled,false);assert.equal(s.captured(),undefined);
    drag(box,200,200,250,230);assert.deepEqual(rect(),[150,130,300,250]);
    drag(box,200,200,-500,-500);assert.deepEqual(rect(),[0,0,300,250]);
    drag(box,100,100,2000,2000);assert.deepEqual(rect(),[500,350,300,250]);
    key('ArrowLeft');key('ArrowUp');key('ArrowLeft',true);key('ArrowUp',true);assert.deepEqual(rect(),[490,340,290,240]);
    key('Escape');assert.equal(overlay.hidden,true);assert.equal(box.hidden,true);assert.equal(s.w.document.activeElement,el('crop'));
    el('crop').click();drag(overlay,20,100,21,101);assert.equal((el('apply') as HTMLButtonElement).disabled,true);
    // A tiny invalid selection starts a new box rather than resizing to negative coordinates.
    drag(box,21,101,100,200);assert.deepEqual(rect(),[21,101,79,99]);
    s.pointer(box,'pointerdown',50,140);s.pointer(overlay,'pointermove',100,180,2);assert.deepEqual(rect(),[21,101,79,99],'another pointer cannot alter the active drag');
    el('cancel').click();assert.equal(s.captured(),undefined);assert.equal(overlay.hidden,true);
    el('crop').click();key('ArrowRight');assert.deepEqual(rect(),[210,150,400,300]);
    overlay.dispatchEvent(new s.w.Event('pointercancel'));assert.equal(overlay.hidden,true);
  }finally{s.dom.window.close();}
});

test('Study crop resizes every edge and corner, preserving the opposite edge and minimum size',()=>{
  for(const edge of ['n','s','e','w','nw','ne','sw','se']){
    const s=selectionSurface();
    try{
      s.drag(s.overlay,100,100,400,350);
      const handle=s.box.querySelector<HTMLElement>(`[data-edge="${edge}"]`)!;
      const x=edge.includes('w')?100:400,y=edge.includes('n')?100:350;
      s.drag(handle,x,y,x+20,y+30);
      assert.deepEqual(s.rect(),[edge.includes('w')?120:100,edge.includes('n')?130:100,
        edge.includes('e')?320:edge.includes('w')?280:300,edge.includes('s')?280:edge.includes('n')?220:250],edge);
      // Drag beyond the opposite edge: dimensions remain positive and at least 12px.
      s.drag(handle,x,y,edge.includes('w')?800:0,edge.includes('n')?600:0);
      const [left,top,width,height]=s.rect();assert.ok(width>=12&&height>=12&&left>=0&&top>=0&&left+width<=800&&top+height<=600,edge);
    }finally{s.dom.window.close();}
  }
});
