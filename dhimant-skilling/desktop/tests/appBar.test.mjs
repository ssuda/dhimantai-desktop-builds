import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {build} from '../../dhimantai-learning/node_modules/esbuild/lib/main.js';
import {JSDOM} from '../../dhimantai-learning/node_modules/jsdom/lib/api.js';

// Exercise the actual native component's DOM, state bridge, commands, layout and
// keyboard boundary without launching a learner's real desktop profile.
const stubs = `
export const registrations = new Map();
export const CommandsRegistry = {registerCommand:(id,fn)=>registrations.set(id,fn)};
export const ICommandService = () => {}, INotificationService = () => {};
export const localize = (_key,text)=>text;
export class Disposable {items=[]; _register(item){this.items.push(item);return item;} dispose(){this.items.forEach(item=>item.dispose());}}
export class Emitter {listeners=new Set();event=fn=>{this.listeners.add(fn);return {dispose:()=>this.listeners.delete(fn)}};fire(value){for(const fn of this.listeners)fn(value);}dispose(){this.listeners.clear();}}
export const $ = selector => {const [tag,...classes]=selector.split('.');const node=document.createElement(tag||'div');node.classList.add(...classes);return node;};
export const append=(parent,node)=>parent.appendChild(node);
export const EventType={KEY_DOWN:'keydown',CLICK:'click'};
export const addDisposableListener=(node,event,fn)=>{node.addEventListener(event,fn);return {dispose:()=>node.removeEventListener(event,fn)}};
export const toAction=action=>action;
`;
const entry = fileURLToPath(new URL('../overlays/src/vs/workbench/browser/parts/dhimantaiAppBar.ts', import.meta.url));
const result = await build({entryPoints:[entry],bundle:true,write:false,format:'cjs',platform:'node',
  tsconfigRaw:{compilerOptions:{experimentalDecorators:true}},plugins:[{name:'native-services',setup(builder){
    builder.onResolve({filter:/\.css$/},()=>({path:'styles',namespace:'empty-css'}));
    builder.onLoad({filter:/.*/,namespace:'empty-css'},()=>({contents:'',loader:'js'}));
    builder.onResolve({filter:/\.js$/},()=>({path:'services',namespace:'native-services'}));
    builder.onLoad({filter:/.*/,namespace:'native-services'},()=>({contents:stubs,loader:'js'}));
  }}]});
// Export the registered bridge from the same bundle's service shim.
const source=result.outputFiles[0].text+'\nmodule.exports.bridge=registrations.get("_dhimantai.setAppBarState");';
const module={exports:{}};
new Function('module','exports','require',source)(module,module.exports,createRequire(import.meta.url));
const {DhimantaiAppBar,bridge}=module.exports;

test('native rail renders profile safely, dispatches actions, and keeps arrow keys inside the lower controls',async()=>{
  const dom=new JSDOM('<body><main></main></body>');globalThis.document=dom.window.document;
  const calls=[],errors=[];
  const bar=new DhimantaiAppBar(()=>[],()=>({}),{}, {executeCommand:async id=>{calls.push(id);}}, {error:error=>errors.push(error)});
  bar.create(document.querySelector('main'));
  const [update,profile]=bar.element.querySelectorAll('button');
  assert.equal(bar.getHeight(28,4),60);
  assert.equal(bar.element.style.getPropertyValue('--dhimantai-action-height'),'28px');
  bridge(null,{status:'downloading',message:'Downloading desktop update… 42%',profile:'Profile — learner@test',initials:'<x'});
  assert.equal(update.getAttribute('aria-label'),'Downloading desktop update… 42%');
  assert.ok(update.querySelector('.codicon-modifier-spin'));
  assert.equal(profile.textContent,'<x');assert.equal(profile.querySelector('x'),null);
  let escaped=false;bar.element.addEventListener('keydown',()=>{escaped=true;});
  bar.focus();assert.equal(document.activeElement,update);
  update.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.equal(document.activeElement,profile);assert.equal(escaped,false);
  profile.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  assert.equal(document.activeElement,update);assert.equal(escaped,false);
  update.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  assert.equal(escaped,true,'up from the first control returns to the native navigation');
  update.click();profile.click();await Promise.resolve();
  assert.deepEqual(calls,['dhimantai.showUpdates','dhimantai.profile']);assert.deepEqual(errors,[]);
  bridge(null,{status:'ready',message:'Ready to apply',profile:'Sign in',initials:''});
  assert.equal(update.dataset.status,'ready');assert.ok(profile.querySelector('.codicon-account'));
  assert.throws(()=>bridge(null,{status:'ready',message:42}),/Invalid/);
  bar.dispose();dom.window.close();delete globalThis.document;
});
