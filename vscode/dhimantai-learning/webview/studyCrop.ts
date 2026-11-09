/** Capture only the owned EPUB document, never the desktop or another editor. */
export interface CropBox {left:number;top:number;width:number;height:number}
export interface CropImage {dataUrl:string;width:number;height:number}
const MAX_IMAGE_BYTES=8*1024*1024;
const intersects=(a:DOMRect,b:CropBox)=>a.right>b.left&&a.left<b.left+b.width&&a.bottom>b.top&&a.top<b.top+b.height;
const bounded=<T>(promise:Promise<T>,ms=10000)=>new Promise<T>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('The selected area could not be captured. Try a smaller area.')),ms);
  promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});

async function imageData(url:string):Promise<string>{
  if(/^data:image\//i.test(url))return url;
  if(!/^(https:|blob:)/i.test(url))throw new Error('This picture cannot be captured.');
  const response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
  if(!response.ok||!/^image\//i.test(response.headers.get('content-type')||''))throw new Error('This picture could not be included in the crop.');
  if(Number(response.headers.get('content-length'))>MAX_IMAGE_BYTES)throw new Error('The picture is too large to capture.');
  const reader=response.body?.getReader();if(!reader)throw new Error('The picture could not be read.');
  const chunks:Uint8Array[]= [];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>MAX_IMAGE_BYTES)throw new Error('The picture is too large to capture.');chunks.push(new Uint8Array(next.value));}}
  finally{await reader.cancel();}
  const blob=new Blob(chunks,{type:response.headers.get('content-type')!});
  return new Promise((resolve,reject)=>{const read=new FileReader();read.onload=()=>resolve(String(read.result));read.onerror=()=>reject(new Error('The picture could not be read.'));read.readAsDataURL(blob);});
}

export async function captureReaderCrop(frame:HTMLIFrameElement,box:CropBox):Promise<CropImage>{
  const doc=frame.contentDocument,rect=frame.getBoundingClientRect();
  if(!doc?.body||!frame.isConnected||box.width<12||box.height<12)throw new Error('Draw a larger box on the page.');
  const local={left:box.left-rect.left,top:box.top-rect.top,width:box.width,height:box.height};
  if(local.left<0||local.top<0||local.left+local.width>rect.width+1||local.top+local.height>rect.height+1)throw new Error('Keep the crop inside the book page.');
  await bounded(doc.fonts.ready);
  const clone=doc.documentElement.cloneNode(true) as HTMLElement;
  // Freeze resolved sizes/fonts: nesting HTML in SVG changes Chromium's default
  // monospace sizing and margin rules unless the displayed styles are explicit.
  const originals=Array.from(doc.querySelectorAll('body,body *'));
  Array.from(clone.querySelectorAll<HTMLElement>('body,body *')).forEach((node,i)=>{
    const computed=doc.defaultView!.getComputedStyle(originals[i]);
    for(const property of Array.from(computed))node.style.setProperty(property,computed.getPropertyValue(property),'important');
  });
  // epub.js themes can use insertRule: textContent alone omits those styles.
  const styles=Array.from(doc.querySelectorAll('style'));
  Array.from(clone.querySelectorAll('style')).forEach((style,i)=>{
    style.textContent=styles[i].sheet?Array.from(styles[i].sheet!.cssRules).map(rule=>rule.cssText).join('\n'):styles[i].textContent;
    if(/url\(\s*["']?(?!data:)[^\s"')]/i.test(style.textContent||''))throw new Error('The page has styles that cannot be captured offline.');
  });
  clone.querySelectorAll('script,iframe,object,embed,link,base,meta,form').forEach(node=>node.remove());
  const images=Array.from(doc.querySelectorAll('img'));
  for(const [i,image] of Array.from(clone.querySelectorAll('img')).entries()){
    const original=images[i],bounds=original.getBoundingClientRect();
    image.removeAttribute('srcset');image.removeAttribute('loading');
    image.style.width=bounds.width+'px';image.style.height=bounds.height+'px';
    if(intersects(bounds,local)){
      if(!original.complete||!original.naturalWidth)throw new Error('Wait for the picture to load, then select it again.');
      image.src=await imageData(original.currentSrc||original.src);
    }else image.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  }
  // A data SVG renders the same paginated HTML/CSS in Chromium. All visible image
  // and font bytes are embedded, so a missing external resource cannot silently
  // turn into a text-only explanation or include a neighbouring source instead.
  // Nested html/body have special viewport/overflow behaviour in foreignObject
  // that drops EPUB's later columns. Ordinary blocks with their measured styles
  // preserve the same column layout without a second document viewport.
  const block=(node:HTMLElement,original:HTMLElement)=>{
    const replacement=doc.createElement('div');
    for(const attribute of Array.from(node.attributes))replacement.setAttribute(attribute.name,attribute.value);
    const computed=doc.defaultView!.getComputedStyle(original);
    for(const property of Array.from(computed))replacement.style.setProperty(property,computed.getPropertyValue(property),'important');
    replacement.style.setProperty('overflow','visible','important');
    replacement.append(...Array.from(node.childNodes));return replacement;
  };
  const body=clone.querySelector('body')!;body.replaceWith(block(body,doc.body));
  const html=new XMLSerializer().serializeToString(block(clone,doc.documentElement));
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${frame.clientWidth}" height="${frame.clientHeight}"><foreignObject width="100%" height="100%">${html}</foreignObject></svg>`;
  const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  await bounded(image.decode());
  const scale=Math.min(2,1800/Math.max(box.width,box.height));
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(box.width*scale);canvas.height=Math.ceil(box.height*scale);
  const context=canvas.getContext('2d');if(!context)throw new Error('Image capture is unavailable.');
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(image,local.left,local.top,box.width,box.height,0,0,canvas.width,canvas.height);
  const dataUrl=canvas.toDataURL('image/png');
  if(dataUrl.length>MAX_IMAGE_BYTES)throw new Error('The crop is too large. Select a smaller area.');
  return {dataUrl,width:canvas.width,height:canvas.height};
}

/** Same 10 KiB chunks and acknowledgements used by Flutter's Study upload. */
export async function uploadStudyCrop(dataUrl:string,requestId:string,source:{source_id:string;revision:string},
    send:(method:string,payload:object)=>Promise<string>,current:()=>boolean){
  if(!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)||dataUrl.length>MAX_IMAGE_BYTES)throw new Error('Select the area again before asking for help.');
  const size=10*1024,total=Math.ceil(dataUrl.length/size);
  for(let index=0;index<total;index++){
    if(!current())throw new Error('The crop request changed.');
    const reply=await send('study_selection_image',{...source,request_id:requestId,selection_request_id:requestId,index,total,data:dataUrl.slice(index*size,(index+1)*size)});
    if(!current())throw new Error('The crop request changed.');
    let ack:any;try{ack=JSON.parse(reply);}catch{}
    if(ack?.status!=='ok'||ack.selection_request_id!==requestId||ack.index!==index||ack.complete!==(index===total-1))throw new Error(ack?.message||'The selected image could not be sent. Try again.');
  }
}

export class StudyCropSelector {
  private epoch=0;
  private drag?:{x:number;y:number;pointerId:number;mode:string;area?:CropBox};
  private area?:CropBox;
  pending=false;
  get selecting(){return !this.ui.overlay.hidden;}
  constructor(private ui:{button:HTMLButtonElement;overlay:HTMLElement;box:HTMLElement;apply:HTMLButtonElement;cancel:HTMLButtonElement;status:HTMLElement;viewer:HTMLElement;
      available:()=>boolean;image:(image:CropImage|undefined)=>void;changed:()=>void}){
    for(const edge of ['n','s','e','w','nw','ne','sw','se']){
      const handle=ui.box.ownerDocument.createElement('span');handle.className='crop-handle';handle.dataset.edge=edge;handle.setAttribute('aria-hidden','true');ui.box.append(handle);
    }
    ui.button.onclick=()=>{
      if(!ui.available())return;this.reset();ui.overlay.hidden=false;ui.button.setAttribute('aria-pressed','true');ui.overlay.focus();ui.changed();
    };
    ui.cancel.onclick=()=>{this.reset();ui.button.focus();};
    ui.apply.onclick=()=>{void this.capture();};
    const point=(event:PointerEvent)=>{const r=ui.overlay.getBoundingClientRect();return {x:Math.max(0,Math.min(r.width,event.clientX-r.left)),y:Math.max(0,Math.min(r.height,event.clientY-r.top))};};
    ui.overlay.onpointerdown=event=>{
      if(this.pending||this.drag||event.button!==0||(event.target as Element).closest('.crop-guidance'))return;
      event.preventDefault();ui.overlay.focus({preventScroll:true});ui.status.hidden=true;
      const handle=(event.target as HTMLElement).closest<HTMLElement>('[data-edge]');
      const mode=this.area&&this.area.width>=12&&this.area.height>=12&&ui.box.contains(event.target as Node)?handle?.dataset.edge??'move':'draw';
      this.drag={...point(event),pointerId:event.pointerId,mode,area:this.area?{...this.area}:undefined};
      if(mode==='draw'){this.area=undefined;ui.box.hidden=true;ui.apply.disabled=true;}
      ui.overlay.setPointerCapture(event.pointerId);
    };
    const adjust=(event:PointerEvent)=>{
      const drag=this.drag;if(!drag||event.pointerId!==drag.pointerId)return;
      const p=point(event),r=ui.overlay.getBoundingClientRect(),dx=p.x-drag.x,dy=p.y-drag.y;
      const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
      if(drag.mode==='draw')this.area={left:Math.min(drag.x,p.x),top:Math.min(drag.y,p.y),width:Math.abs(dx),height:Math.abs(dy)};
      else if(drag.area){
        const a=drag.area;
        if(drag.mode==='move')this.area={...a,left:clamp(a.left+dx,0,r.width-a.width),top:clamp(a.top+dy,0,r.height-a.height)};
        else{
          let left=a.left,top=a.top,right=a.left+a.width,bottom=a.top+a.height;
          if(drag.mode.includes('w'))left=clamp(left+dx,0,right-12);
          if(drag.mode.includes('e'))right=clamp(right+dx,left+12,r.width);
          if(drag.mode.includes('n'))top=clamp(top+dy,0,bottom-12);
          if(drag.mode.includes('s'))bottom=clamp(bottom+dy,top+12,r.height);
          this.area={left,top,width:right-left,height:bottom-top};
        }
      }
      this.paint();
    };
    ui.overlay.onpointermove=adjust;
    ui.overlay.onpointerup=event=>{if(event.pointerId!==this.drag?.pointerId)return;adjust(event);this.stopDrag();};
    ui.overlay.onlostpointercapture=()=>{this.drag=undefined;};
    ui.overlay.onpointercancel=()=>this.reset();
    ui.overlay.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();this.reset();ui.button.focus();return;}
      if(this.pending||this.drag||(event.target as Element).closest('button'))return;
      if(event.key==='Enter'){event.preventDefault();void this.capture();return;}
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();const r=ui.overlay.getBoundingClientRect();
      this.area??={left:r.width/4,top:r.height/4,width:r.width/2,height:r.height/2};
      const axis=event.key==='ArrowLeft'||event.key==='ArrowRight'?'left':'top',dimension=axis==='left'?'width':'height';
      const limit=axis==='left'?r.width:r.height,delta=['ArrowLeft','ArrowUp'].includes(event.key)?-10:10;
      if(event.shiftKey)this.area[dimension]=Math.max(12,Math.min(limit-this.area[axis],this.area[dimension]+delta));
      else this.area[axis]=Math.max(0,Math.min(limit-this.area[dimension],this.area[axis]+delta));
      this.paint();
    };
  }
  private stopDrag(){const drag=this.drag;this.drag=undefined;if(drag&&this.ui.overlay.hasPointerCapture(drag.pointerId))this.ui.overlay.releasePointerCapture(drag.pointerId);}
  reset(){this.epoch++;this.stopDrag();this.area=undefined;this.pending=false;this.ui.apply.disabled=true;this.ui.overlay.hidden=true;this.ui.box.hidden=true;this.ui.status.hidden=true;this.ui.button.setAttribute('aria-pressed','false');this.ui.image(undefined);this.ui.changed();}
  private paint(){const area=this.area;if(!area)return;const box=this.ui.box;box.hidden=false;Object.assign(box.style,{left:area.left+'px',top:area.top+'px',width:area.width+'px',height:area.height+'px'});this.ui.apply.disabled=this.pending||area.width<12||area.height<12;}
  private async capture(){
    if(this.pending||this.drag||!this.ui.available())return;
    const area=this.area;if(!area||area.width<12||area.height<12){this.ui.status.textContent='Draw a larger box on the page.';this.ui.status.hidden=false;return;}
    const epoch=this.epoch,r=this.ui.overlay.getBoundingClientRect(),frame=this.ui.viewer.querySelector('iframe');
    if(!frame)return;
    this.pending=true;this.ui.apply.disabled=true;this.ui.changed();this.ui.status.textContent='Capturing selected area…';this.ui.status.hidden=false;
    try{
      const image=await captureReaderCrop(frame,{...area,left:area.left+r.left,top:area.top+r.top});
      if(epoch!==this.epoch)return;
      this.ui.overlay.hidden=true;this.ui.box.hidden=true;this.ui.button.setAttribute('aria-pressed','false');this.ui.status.hidden=true;this.ui.image(image);
    }catch(error){if(epoch===this.epoch){this.ui.status.textContent=error instanceof Error?error.message:'The area could not be captured. Select it again.';this.ui.status.hidden=false;}}
    finally{if(epoch===this.epoch){this.pending=false;this.ui.apply.disabled=false;this.ui.changed();}}
  }
}
