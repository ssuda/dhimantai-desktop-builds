import {getDocument, PDFWorker, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask} from 'pdfjs-dist/legacy/build/pdf.mjs';

type ReaderEvent = (event: {event:string;[key:string]:unknown}) => void;
const pageStyle = `html,body{margin:0;background:white}body{display:flex;justify-content:center;min-height:100vh}.page{position:relative;flex:none;margin:auto}img{display:block;width:100%;height:100%}
.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;transform-origin:0 0;text-size-adjust:none;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));--min-font-size-inv:calc(1/var(--min-font-size))}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;user-select:text}
.textLayer>:not(.markedContent),.markedContent span:not(.markedContent){--font-height:0;font-size:calc(var(--text-scale-factor)*var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
.markedContent{display:contents}.textLayer ::selection{background:#1687ff55}`;

/** Keep the last complete page mounted while a navigation/resize renders its successor. */
export class PdfStudyReader {
  private frame = document.createElement('iframe');
  private pdf?: PDFDocumentProxy;
  private loading?: PDFDocumentLoadingTask;
  private worker?: Worker;
  private pdfWorker?: PDFWorker;
  private workerUrl = '';
  private renderTask?: RenderTask;
  private observer: ResizeObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;
  private page = 1;
  private zoom = 1;
  constructor(private viewer: HTMLElement, private emit: ReaderEvent) {
    this.frame.title = 'PDF textbook';
    this.frame.setAttribute('sandbox','allow-same-origin');
    this.frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
    this.observer = new ResizeObserver(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if(this.pdf && viewer.clientWidth && viewer.clientHeight) void this.render(); },100);
    });
    this.observer.observe(viewer);
  }
  async open(data: Uint8Array, assets: string, cursor?: string, fontSize='100%') {
    this.zoom = parseInt(fontSize,10)/100;
    const response = await fetch(assets+'pdf.worker.min.mjs');
    if (!response.ok) throw new Error('The PDF reader could not be loaded.');
    const script = await response.text(); if(this.disposed)return;
    this.workerUrl = URL.createObjectURL(new Blob([script],{type:'text/javascript'}));
    this.worker = new Worker(this.workerUrl,{type:'module'});
    this.pdfWorker = PDFWorker.create({port:this.worker});
    this.loading = getDocument({data,worker:this.pdfWorker,
      cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
    this.pdf = await this.loading.promise; if(this.disposed)return;
    this.page = Math.min(this.pdf.numPages,Math.max(1,Number(cursor?.match(/^pdf:(\d+)$/)?.[1] || 1)));
    await new Promise<void>(resolve => {this.frame.onload=()=>resolve();this.frame.srcdoc=`<!doctype html><html><head><style>${pageStyle}</style></head><body></body></html>`;this.viewer.replaceChildren(this.frame);});
    if(this.disposed)return;
    this.frame.contentDocument!.addEventListener('mouseup',()=>{
      const text=this.frame.contentWindow?.getSelection()?.toString().trim();
      if(text)this.emit({event:'text_selected',text});
    });
    await this.render();
  }
  private async render() {
    const pdf=this.pdf, doc=this.frame.contentDocument;
    if(!pdf||!doc?.body||this.disposed||!this.viewer.clientWidth||!this.viewer.clientHeight)return;
    const current=++this.generation, pageNumber=this.page;
    this.renderTask?.cancel();
    try {
      const page=await pdf.getPage(pageNumber);if(current!==this.generation||this.disposed)return;
      const original=page.getViewport({scale:1});
      const scale=Math.min((this.viewer.clientWidth-16)/original.width,(this.viewer.clientHeight-16)/original.height)*this.zoom;
      const viewport=page.getViewport({scale:Math.max(.1,scale)});
      const density=Math.min(window.devicePixelRatio||1,2,4096/Math.max(viewport.width,viewport.height));
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*density);canvas.height=Math.ceil(viewport.height*density);
      this.renderTask=page.render({canvas,viewport:page.getViewport({scale:viewport.scale*density})});
      await this.renderTask.promise;
      const wrapper=doc.createElement('div');wrapper.className='page';wrapper.style.cssText=`width:${viewport.width}px;height:${viewport.height}px;--total-scale-factor:${viewport.scale*page.userUnit}`;
      const image=doc.createElement('img');image.alt=`Page ${pageNumber}`;image.src=canvas.toDataURL('image/png');wrapper.append(image);
      const text=doc.createElement('div');text.className='textLayer';wrapper.append(text);
      await new TextLayer({textContentSource:await page.getTextContent(),container:text,viewport}).render();
      await image.decode();
      if(current!==this.generation||this.disposed)return;
      doc.body.replaceChildren(wrapper);this.frame.contentWindow?.scrollTo(0,0);
      this.emit({event:'reader_ready'});
      this.emit({event:'page_changed',cfi:'pdf:'+pageNumber,pageIndex:pageNumber,totalPages:pdf.numPages,atStart:pageNumber===1,atEnd:pageNumber===pdf.numPages});
    } catch(error) {
      if(current===this.generation&&!this.disposed&&(error as Error).name!=='RenderingCancelledException')this.emit({event:'error'});
    }
  }
  nextPage(){if(this.pdf&&this.page<this.pdf.numPages){this.page++;void this.render();}}
  prevPage(){if(this.page>1){this.page--;void this.render();}}
  setFontSize(value:string){this.zoom=parseInt(value,10)/100;void this.render();}
  clearSelection(){this.frame.contentWindow?.getSelection()?.removeAllRanges();}
  destroy(){this.disposed=true;this.generation++;clearTimeout(this.timer);this.observer.disconnect();this.renderTask?.cancel();void this.loading?.destroy().catch(()=>{});this.pdfWorker?.destroy();this.worker?.terminate();if(this.workerUrl)URL.revokeObjectURL(this.workerUrl);this.frame.remove();}
}
