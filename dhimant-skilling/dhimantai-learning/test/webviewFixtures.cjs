// Shared fixture host for the real compiled learning webviews (Instructor, Doubt Solver, Catalog, Certificates, Written practice).
const {chromium}=require('playwright-core');
const {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync}=require('node:fs');
const {createServer}=require('node:http');
const {join,resolve,extname}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const root=resolve(__dirname,'..'),output=process.env.B2C_LAYOUT_ARTIFACTS||'/tmp/dhimantai-b2c-layout';
const commands=new Map(),panels=[],disposable={dispose(){}};
const stub=new Proxy(function(){return stub},{get:(_,key)=>key==='then'?undefined:key==='dispose'?()=>{}:stub,apply:()=>disposable,construct:()=>stub});
const fallback=value=>new Proxy(value,{get:(o,k)=>k in o?o[k]:stub});
let origin;
const vscode=fallback({Uri:{joinPath:(uri,...parts)=>({fsPath:join(uri.fsPath,...parts)}),file:fsPath=>({fsPath})},ViewColumn:{One:1},
 Disposable:Object.assign(class {dispose(){}},{from:()=>disposable}),TabInputWebview:class{},EventEmitter:class{event=()=>disposable;fire(){}dispose(){}},
 env:fallback({appName:'Visual Studio Code'}),workspace:fallback({getConfiguration:()=>({get:(_,value)=>value}),workspaceFolders:[],isTrusted:true}),
 window:fallback({tabGroups:{all:[]},createWebviewPanel:()=>{const panel={webview:{cspSource:origin,html:'',asWebviewUri:uri=>origin+'/media/'+uri.fsPath.split('/media/')[1],onDidReceiveMessage:()=>disposable,postMessage:async()=>true},reveal(){},onDidDispose:()=>disposable,onDidChangeViewState:()=>disposable,dispose(){}};panels.push(panel);return panel;}}),
 commands:fallback({registerCommand:(name,fn)=>{commands.set(name,fn);return disposable;},executeCommand:async()=>{}})});
const Module=require('node:module'),load=Module._load;
Module._load=function(id,...rest){return id==='vscode'?vscode:load.call(this,id,...rest);};
const {registerLearningRoom}=require('../out/src/learningRoom');
const {CourseCatalog}=require('../out/src/courseCatalog');
const {courseGradeHtml}=require('../out/src/courseGradeHtml');
const {writtenHtml}=require('../out/src/writtenPractice');
Module._load=load;
const names=['Course overview','Set up your environment','Gradients and parameter updates','Tensors and shapes','Train on real speech','Evaluate recognition'];
const chapters=names.map((name,i)=>({id:'chapter-'+i,name,lesson:name,free:true,progress:{status:i<2?'covered':i===2?'in_progress':'not_started',covered:i<2?2:0,total:2,topics:[{id:'topic',title:'Understand '+name.toLowerCase(),status:i<2?'covered':'in_progress'}]}}));
const courses=[{id:'speech',title:'Developing Speech-to-Text Models',summary:'Build and evaluate a speech recognition pipeline. Understand data preparation, model training and the quality of the final transcription.',level:'Intermediate',category:'AI & Machine Learning',prerequisites:'Basic Python',enrolled:true,unlocked:true,can_join:true,access_days:60,chapters},
 {id:'llm',title:'Build an LLM from Scratch',summary:'Implement the core components of a language model and understand how attention turns tokens into predictions.',level:'Advanced',category:'AI & Machine Learning',prerequisites:'Python and linear algebra',enrolled:false,can_join:true,access_days:60,chapters:chapters.map(c=>({...c,progress:undefined}))},
 {id:'python',title:'Python for Problem Solving',summary:'Write readable programs, work with collections and test your own solutions.',level:'Beginner',category:'Software Engineering',prerequisites:'No programming experience required',enrolled:true,is_free:true,can_join:true,chapters:chapters.map(c=>({...c,progress:{...c.progress,status:'not_started'}}))}];
const grade={course_id:'speech',course_title:courses[0].title,score:70,grade:'B',eligible:false,passed_count:4,required_count:6,exercise_score:80,project_score:60,policy:{description:'Complete the required independent course activities.',scope:'Coursework'},blockers:['Complete the speech evaluation project.','Review the independent transcription exercise.'],topics:[],requirements:[]};
const pages={};
const theme=`<style>:root{--vscode-font-family:Arial,sans-serif;--vscode-font-size:15px;--vscode-foreground:#242338;--vscode-editor-foreground:#242338;--vscode-editor-background:#fbfbfe;--vscode-editorWidget-background:#fff;--vscode-descriptionForeground:#626176;--vscode-panel-border:#dcdbea;--vscode-widget-border:#dcdbea;--vscode-button-background:#6042cb;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#5033b9;--vscode-button-secondaryBackground:#eeebf7;--vscode-button-secondaryForeground:#302b49;--vscode-input-background:#fff;--vscode-input-foreground:#242338;--vscode-input-border:#ccc9df;--vscode-dropdown-background:#fff;--vscode-dropdown-foreground:#242338;--vscode-focusBorder:#7653df;--vscode-progressBar-background:#3a9468;--vscode-testing-iconPassed:#268051;--vscode-badge-background:#eeebf7;--vscode-badge-foreground:#5033b9;--vscode-textLink-foreground:#6042cb;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-selectionBackground:#dcd4fa;--vscode-editor-inactiveSelectionBackground:#ece6fa;--vscode-editorWarning-foreground:#a26513;--vscode-textBlockQuote-background:#f1eef8}body{margin:0}*{box-sizing:border-box}</style>`;
const server=createServer((req,res)=>{const path=decodeURIComponent(req.url.split('?')[0]);if(pages[path]){res.setHeader('Content-Type','text/html');res.end(pages[path]);return;}if(path.startsWith('/media/')&&!path.includes('..')){try{const file=join(root,path);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));return;}catch{}}res.statusCode=404;res.end();});
async function startFixtures(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const storage=mkdtempSync(join(tmpdir(),'b2c-layout-'));
 const context={subscriptions: [], extensionUri:{fsPath:root},extensionPath:root,globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:()=>undefined,update:async()=>{}}};
 const session={user:{id:'fixture'},access_token:'fixture'};
 registerLearningRoom(context,()=> 'staging',()=>({apiUrl:'https://fixture.invalid'}),{session:async()=>session,signIn:async()=>session,accessToken:async()=> 'fixture'});
 await commands.get('dhimantai.openLearningRoom')('Developing Speech-to-Text Models');
 const prepare=html=>html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace('</head>',theme+'</head>').replace(/<body(?: class="([^"]*)")?/,(_body,classes)=>'<body class="'+(classes?classes+' ':'')+'vscode-light"');
 pages['/room']=prepare(panels.at(-1).webview.html).replace(/<script[^>]*src="[^"]*livekit-client\.umd\.js"[^>]*><\/script>/,'');
 pages['/written']=prepare(writtenHtml({id:'trace',title:'Trace a recursive call',question:'Explain when each call returns.',course:'Algorithms with Python'},
   {answer:'',assistance:'',usedTutor:false},'nonce',undefined,undefined,'',undefined,true));
 vscode.env.appName='dhimantAI';
 await commands.get('dhimantai.openDoubtSolver')();
 pages['/doubt']=prepare(panels.at(-1).webview.html).replace(/<script[^>]*src="[^"]*livekit-client\.umd\.js"[^>]*><\/script>/,'');
 const catalog=Object.create(CourseCatalog.prototype);Object.assign(catalog,{panel:{webview:{html:''}},sequence:0,awaitingPayment:false,projects:[],studyCourses:new Set(),companions:[],environment:()=> 'production',selection:{account:'fixture',environment:'production',catalog:{individual:true,courses,offers:[]}}});catalog.render(catalog.selection.catalog,'');pages['/catalog']=prepare(catalog.panel.webview.html);
 const previewCourses=require('../../../website/upskill/catalog.json').courses
   .filter(c=>['algorithms-python','python-backend-fastapi'].includes(c.id))
   .map(c=>({...c,can_join:true,enrolled:false,chapters:c.chapters.map((name,i)=>({id:c.id+'-'+i,name,free:i===0}))}));
 catalog.selection={environment:'production',catalog:{individual:false,courses:previewCourses,offers:[]}};
 catalog.render(catalog.selection.catalog,'');
 const catalogHtml=catalog.panel.webview.html;
 const nonce=catalogHtml.match(/<style nonce="([^"]+)"/)[1];
 pages['/previews']=catalogHtml.replace('</head>',theme.replace('<style>',`<style nonce="${nonce}">`)+'</head>');
 pages['/certificates']=prepare(courseGradeHtml('nonce',undefined,[],'',0,false,true,undefined,'fixture',courses.filter(c=>c.enrolled).map(c=>({id:c.id,title:c.title,grade:{...grade,course_id:c.id,course_title:c.title}}))));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({chapters})=>{
   window.posts=[];window.saved={};window.rooms=[];window.chat=[];
   window.notebookScroller=()=>{const panel=document.getElementById('learning-document');return panel&&getComputedStyle(panel).overflowY==='auto'?panel:document.scrollingElement;};
   const send=data=>window.dispatchEvent(new MessageEvent('message',{data,origin:location.origin}));window.fixturePost=send;
   window.acquireVsCodeApi=()=>({getState:()=>window.saved,setState:s=>window.saved=s,postMessage:m=>{window.posts.push(m);setTimeout(()=>{
     if(m.type==='ready')send({type:'openTutor',mode:document.body.dataset.notebookMode});
     if(m.type==='tutorLessons')send({type:'tutorLessons',attempt:m.attempt,browse:m.browse,courses:[{name:'Developing Speech-to-Text Models',chapters},
       ...(document.body.dataset.notebookMode==='doubt_solver'?[{name:'Python',chapters:[{id:'python-lists',name:'Lists'},{id:'locked',name:'Locked chapter',locked:true},{id:'expired',name:'Expired chapter',expired:true}]}]:[])]});
     if(m.type==='join'){
       send({type:'restoreNotebook',attempt:m.attempt,documentKey:'fixture',notebook:{version:1,title:'Learning notebook',cells:[],drafts:[],textDraft:''}});
       send({type:'grant',attempt:m.attempt,url:'unused',token:'unused',chapterId:m.chapterId});
     }
     if(m.type==='codeAction')send({...m,type:'codeResult',execution:{status:'exited',exit_code:0,stdout:m.source.includes('learning_rate')?'1.95':'tensor([4., 5., 6.])',stderr:'',truncated:false}});
   },0);}});
   const agent={identity:'worker',isAgent:true,trackPublications:new Map()};
   class Room{listeners=new Map();remoteParticipants=new Map([['worker',agent]]);localParticipant={registerRpcMethod(){},performRpc:async()=> 'ok',sendText:async text=>window.chat.push(text)};constructor(){window.rooms.push(this);}on(name,fn){this.listeners.set(name,fn);}async connect(){}async disconnect(){}registerTextStreamHandler(){}}
   window.LivekitClient={Room,RoomEvent:Object.fromEntries(['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'].map(x=>[x,x]))};
   window.publishPacket=packet=>window.rooms.at(-1).listeners.get('DataReceived')(new TextEncoder().encode(JSON.stringify(packet)),agent);
   window.publish=content=>window.publishPacket({method:'display_on_screen',content});
 },{chapters});
 mkdirSync(output,{recursive:true});
 const close=async()=>{await browser.close();rmSync(storage,{recursive:true,force:true});await new Promise(r=>server.close(r));};
 return {origin,page,errors,browser,pages,output,theme,close};
}
module.exports={startFixtures,courses,chapters,grade,root};
