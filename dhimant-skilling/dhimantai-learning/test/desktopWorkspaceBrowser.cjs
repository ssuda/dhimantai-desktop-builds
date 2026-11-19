// Actual host templates and compiled webviews, with local deterministic learning data.
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
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const storage=mkdtempSync(join(tmpdir(),'b2c-layout-'));
 const context={extensionUri:{fsPath:root},extensionPath:root,globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:()=>undefined,update:async()=>{}}};
 const session={user:{id:'fixture'},access_token:'fixture'};
 registerLearningRoom(context,()=> 'staging',()=>({apiUrl:'https://fixture.invalid'}),{session:async()=>session,signIn:async()=>session,accessToken:async()=> 'fixture'});
 await commands.get('dhimantai.openLearningRoom')('Developing Speech-to-Text Models');
 const prepare=html=>html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace('</head>',theme+'</head>').replace(/<body(?: class="([^"]*)")?/,(_body,classes)=>'<body class="'+(classes?classes+' ':'')+'vscode-light"');
 pages['/room']=prepare(panels.at(-1).webview.html).replace(/<script[^>]*src="[^"]*livekit-client\.umd\.js"[^>]*><\/script>/,'');
 vscode.env.appName='dhimantAI';
 await commands.get('dhimantai.openDoubtSolver')();
 pages['/doubt']=prepare(panels.at(-1).webview.html).replace(/<script[^>]*src="[^"]*livekit-client\.umd\.js"[^>]*><\/script>/,'');
 const catalog=Object.create(CourseCatalog.prototype);Object.assign(catalog,{panel:{webview:{html:''}},sequence:0,awaitingPayment:false,projects:[],studyCourses:new Set(),companions:[],environment:()=> 'production',selection:{account:'fixture',environment:'production',catalog:{individual:true,courses,offers:[]}}});catalog.render(catalog.selection.catalog,'');pages['/catalog']=prepare(catalog.panel.webview.html);
 pages['/certificates']=prepare(courseGradeHtml('nonce',undefined,[],'',0,false,true,undefined,'fixture',courses.filter(c=>c.enrolled).map(c=>({id:c.id,title:c.title,grade:{...grade,course_id:c.id,course_title:c.title}}))));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
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
 await page.goto(origin+'/room');await page.getByRole('button',{name:'Gradients and parameter updates',exact:true}).click();
 await page.waitForFunction(()=>window.rooms.length>0&&document.getElementById('tutor').hidden);
 await page.evaluate(()=>window.publish('## Gradients and parameter updates\n\nA gradient tells us how the loss changes when a parameter changes. We use it to make a small update in the direction that reduces the loss.\n\n1. **Forward pass:** compute the prediction and loss.\n2. **Backward pass:** calculate the gradient.\n3. **Optimizer step:** update the weights.\n\n```python\nimport torch\nx = torch.tensor([1., 2., 3.])\nprint(x + 3)\n```'));
 await page.locator('[data-action="run"]').first().click();await page.locator('.practice-output').first().waitFor({state:'visible'});
 await page.locator('#message').fill('Why do we subtract the gradient?');
 await page.locator('#choose-course').click();
 await page.locator('#course-selection').waitFor({state:'visible'});
 await page.locator('#selection-back').click();
 await page.keyboard.press('Alt+Shift+a');
 assert.equal(await page.locator('#message').inputValue(),'Why do we subtract the gradient?');
 for(const [width,height] of [[1600,1000],[1365,768],[1200,1000],[1024,768],[768,1000],[420,800],[1280,600]]){
   await page.setViewportSize({width,height});
   assert.equal(await page.locator('#learning-coach,#learning-outline').count(),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'room overflow at '+width);
   const feed=await page.locator('#feed').boundingBox(),composer=await page.locator('#message-bar').boundingBox();
   assert.ok(composer.y>=feed.y+feed.height-1 && Math.abs(composer.width-feed.width)<2,'composer follows the full-width notebook at '+width);
   await page.locator('#message').scrollIntoViewIfNeeded();
   await page.locator('.composer-menu summary').click();
   assert.ok(await page.locator('#attach-images').isVisible());
   await page.locator('.composer-menu summary').click();
   await page.screenshot({path:join(output,'room-'+width+'.png')});
 }
 await page.setViewportSize({width:1600,height:1000});
 await page.locator('#message').fill('Why do we subtract the gradient?');await page.locator('#send').click();await page.waitForFunction(()=>window.chat.some(text=>text.includes('subtract the gradient')));
 await page.evaluate(()=>{document.body.className='vscode-dark';document.documentElement.style.setProperty('--vscode-editor-background','#171720');document.documentElement.style.colorScheme='dark';});
 await page.evaluate(()=>{for(const [key,value] of Object.entries({'--vscode-foreground':'#eceaf7','--vscode-editor-foreground':'#eceaf7','--vscode-editorWidget-background':'#22222f','--vscode-descriptionForeground':'#b6b2cd','--vscode-input-background':'#242432','--vscode-input-foreground':'#eceaf7','--vscode-dropdown-background':'#242432','--vscode-dropdown-listBackground':'#242432','--vscode-button-secondaryBackground':'#353047','--vscode-button-secondaryForeground':'#eceaf7','--vscode-dropdown-foreground':'#eceaf7','--vscode-panel-border':'#45405b'}))document.documentElement.style.setProperty(key,value);});
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(output,'room-dark.png')});
 // Exercise the independent desktop notebook and the stacked narrow layout.
 await page.evaluate(()=>{for(let i=0;i<18;i++)window.publish('## Speech check '+i+'\n\n'+('Keep source, sample rate and split decisions with the experiment. '.repeat(18)));});
 for(const width of [1600,420]) {
   await page.setViewportSize({width,height:1000});
   const entry=page.getByRole('heading',{name:'Speech check 4',exact:true});
   await entry.evaluate(el=>{const scroller=window.notebookScroller();scroller.scrollTop+=el.getBoundingClientRect().top-250;});
   const bounds=await entry.boundingBox();
   await page.mouse.move(bounds.x+Math.min(100,bounds.width/2),bounds.y+10);
   const before=await page.evaluate(()=>window.notebookScroller().scrollTop);await page.mouse.wheel(0,600);
   await page.waitForFunction(y=>window.notebookScroller().scrollTop>y+100,before);
   const lower=await page.evaluate(()=>window.notebookScroller().scrollTop);await page.mouse.wheel(0,-400);
   await page.waitForFunction(y=>window.notebookScroller().scrollTop<y-100,lower);
   // Let the wheel animation finish before comparing a passive update.
   await page.evaluate(()=>new Promise(r=>setTimeout(r,150)));
   const reading=await page.evaluate(()=>window.notebookScroller().scrollTop);
   await page.evaluate(()=>window.publish('## A later reply\n\n'+Array.from({length:18},(_,i)=>'Step '+(i+1)+': Keep the source, sample rate and speaker split with your experiment. Your earlier answers remain available.').join('\n\n')));
   assert.ok(Math.abs(await page.evaluate(()=>window.notebookScroller().scrollTop)-reading)<3,'incoming reply preserves reading position at '+width);
   await page.locator('#latest').click();
   const latest=await page.locator('#feed > article').last().boundingBox();
   assert.ok(latest.y>=0 && latest.y<900,'Jump to latest reveals the reply rather than the composer at '+width+': '+JSON.stringify(latest));
   await page.evaluate(()=>document.getElementById('feed').focus({preventScroll:true}));
   const atLatest=await page.evaluate(()=>window.notebookScroller().scrollTop);await page.keyboard.press('PageUp');
   await page.waitForFunction(y=>window.notebookScroller().scrollTop<y,atLatest);
   await page.evaluate(()=>new Promise(resolve=>{let prior=window.notebookScroller().scrollTop,stable=0,frames=0;const tick=()=>{const top=window.notebookScroller().scrollTop;stable=top===prior?stable+1:0;prior=top;if(stable>=10||++frames>=90)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);}));
   await page.screenshot({path:join(output,'chat-scroll-'+width+'.png')});
 }
 for(const name of ['catalog','certificates']){
   await page.goto(origin+'/'+name);
   for(const width of [1600,1024,420]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' overflow at '+width);await page.screenshot({path:join(output,name+'-'+width+'.png'),fullPage:true});}
 }
 await page.goto(origin+'/doubt');
 await page.locator('#lesson-course option').first().waitFor({state:'attached'});
 assert.equal(await page.locator('#course-selection').isVisible(),true);
 assert.equal(await page.locator('#learning-workspace').isVisible(),false);
 assert.equal(await page.locator('#learning-outline, #learning-coach, #toggle-outline, #toggle-coach').count(),0);
 await page.setViewportSize({width:1365,height:1000});
 assert.equal(await page.locator('#course-selection').count(),1);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.screenshot({path:join(output,'doubt-selection.png')});
 await page.locator('#lesson-search').fill('Gradients');
 assert.equal(await page.locator('#lesson-list button').count(),1);
 await page.getByRole('button',{name:'Gradients and parameter updates',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Doubt Solver connected');
 assert.equal(await page.locator('#course-selection').isVisible(),false);
 await page.evaluate(()=>window.publish('## Why does the gradient point uphill?\n\nThe gradient points toward the greatest increase in loss. Subtracting it moves the parameters in the opposite direction.\n\n```python\nlearning_rate = 0.1\nweight = 2.0\ngradient = 0.5\nprint(weight - learning_rate * gradient)\n```'));
 await page.locator('[data-action="run"]').first().click();
 await page.locator('.practice-output').first().waitFor({state:'visible'});
 await page.locator('#message').fill('Why do we subtract the gradient?');
 await page.locator('#send').click();
 await page.waitForFunction(()=>window.chat.some(text=>text.includes('subtract the gradient')));
 await page.locator('#message').fill('Keep my follow-up draft');
 await page.locator('#doubt-tried').fill('I tried adding the gradient.');
 const leaves=await page.evaluate(()=>window.posts.filter(m=>m.type==='leave').length);
 await page.locator('#choose-course').click();
 await page.waitForFunction(()=>document.getElementById('lesson-list').getAttribute('aria-busy')==='false');
 assert.equal(await page.evaluate(()=>window.posts.filter(m=>m.type==='leave').length),leaves,'opening selection preserves the live session');
 await page.locator('#selection-back').click();
 assert.equal(await page.locator('#message').inputValue(),'Keep my follow-up draft');
 assert.equal(await page.locator('#doubt-tried').inputValue(),'I tried adding the gradient.');
 await page.keyboard.press('Alt+Shift+a');
 assert.equal(await page.locator('#message').evaluate(el=>el===document.activeElement),true);
 const fileChooser=page.waitForEvent('filechooser');
 await page.locator('.composer-menu summary').click();
 await page.locator('#attach-images').click();
 await (await fileChooser).setFiles({name:'question.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZpWkAAAAASUVORK5CYII=','base64')});
 await page.locator('.attachment').waitFor({state:'visible'});
 await page.locator('.composer-menu summary').click();
 const muted=await page.locator('#sound').getAttribute('aria-pressed');
 await page.locator('#sound').click();assert.notEqual(await page.locator('#sound').getAttribute('aria-pressed'),muted);
 assert.equal(await page.locator('#audio-microphone').isVisible(),true);
 for(const width of [1600,1365,1200,1024,768,420]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Doubt Solver overflow at '+width);
   const documentBox=await page.locator('#learning-document').boundingBox();
   assert.ok(documentBox.width>=width-50,'Doubt Solver uses the available room width');
   assert.equal(await page.locator('#message-bar').evaluate(el=>el.parentElement.id),'learning-document');
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.screenshot({path:join(output,'doubt-room-'+width+'.png')});
   await page.locator('#message').scrollIntoViewIfNeeded();
   await page.screenshot({path:join(output,'doubt-composer-'+width+'.png')});
 }
 await page.locator('#choose-course').click();
 await page.waitForFunction(()=>document.getElementById('lesson-list').getAttribute('aria-busy')==='false');
 await page.locator('#lesson-course').selectOption('Python');
 assert.equal(await page.getByRole('button',{name:'Locked chapter · Locked',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Expired chapter · Access ended · Buy again',exact:true}).focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>window.posts.at(-1).type),'courseCatalog');
 await page.locator('#lesson-search').fill('missing');assert.match(await page.locator('#lesson-list').innerText(),/No chapters match/);
 await page.locator('#lesson-search').fill('Lists');
 await page.getByRole('button',{name:'Lists',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Doubt Solver connected');
 assert.equal(await page.evaluate(()=>window.posts.filter(m=>m.type==='join').at(-1).chapterId),'python-lists');
 assert.equal(await page.locator('.workspace-title h1').innerText(),'Lists');
 await page.locator('#choose-course').click();
 await page.waitForFunction(()=>document.getElementById('lesson-list').getAttribute('aria-busy')==='false');
 await page.evaluate(()=>window.fixturePost({type:'tutorLessons',attempt:window.posts.filter(m=>m.type==='tutorLessons').at(-1).attempt,browse:true,courses:[],error:'Offline. Try again.'}));
 assert.equal(await page.locator('#reload-lessons').isVisible(),true);
 await page.locator('#reload-lessons').click();
 await page.waitForFunction(()=>document.getElementById('lesson-list').getAttribute('aria-busy')==='false');
 for(const width of [1365,768,420]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'selection overflow at '+width);
   await page.screenshot({path:join(output,'doubt-selection-'+width+'.png'),fullPage:true});
 }
 // Real compiled chat history and missing-setup presentation, with controlled transport.
 await page.locator('#selection-back').click();
 await page.evaluate(()=>window.fixturePost({type:'doubtHistory',chats:[
   {id:'11111111-1111-4111-8111-111111111111',title:'Why does ScriptedModel return None?',course:'Build AI Agents',chapter:'python-lists'},
   {id:'22222222-2222-4222-8222-222222222222',title:'How do gradients update weights?',course:'Developing Speech-to-Text Models',chapter:'chapter-2'},
 ]}));
 await page.locator('#doubt-history summary').click();
 assert.equal(await page.locator('#doubt-chat-list button').count(),2);
 await page.evaluate(()=>window.publish('## Predict the third printed line\n\n```python\nmodel = ScriptedModel([1, 2])\nprint(model.reply([]))\n```\n\n```python prediction-only\nprint(missing_name)\n```'));
 const incomplete=page.locator('.practice-code-editor').last();
 assert.equal(await incomplete.locator('[data-action="run"]').isDisabled(),true);
 assert.match(await incomplete.locator('.code-completeness').innerText(),/Missing setup: ScriptedModel/);
 assert.equal(await page.locator('.code-reading-only [data-action="run"]').count(),0);
 for(const width of [1365,420]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'chat history overflow at '+width);
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.screenshot({path:join(output,'doubt-chat-history-'+width+'.png')});
   await incomplete.scrollIntoViewIfNeeded();
   await page.screenshot({path:join(output,'doubt-missing-setup-'+width+'.png')});
 }
 // The same textbook figure can arrive through an image event and lesson Markdown.
 await page.route('https://lesson-images.invalid/loop.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160" viewBox="0 0 640 160"><rect width="640" height="160" rx="12" fill="#f0ecff"/><g fill="#302b49" font-family="Arial" font-size="24" text-anchor="middle"><text x="100" y="90">Observe</text><text x="320" y="90">Decide</text><text x="540" y="90">Act</text></g><path d="M170 80h70m-10-8 10 8-10 8m170-8h70m-10-8 10 8-10 8" fill="none" stroke="#6042cb" stroke-width="3"/></svg>'}));
 await page.goto(origin+'/room');await page.getByRole('button',{name:'Gradients and parameter updates',exact:true}).click();
 await page.waitForFunction(()=>window.rooms.length>0&&document.getElementById('tutor').hidden);
 await page.evaluate(()=>{
   const source='https://lesson-images.invalid/loop.svg';
   window.publishPacket({method:'draw_svg',image_url:source,label:'Agent loop [1]'});
   window.publish('## Agent loop\n\n![Original figure]('+source+' "Textbook")\n\nObserve the situation, decide what to do, then act.');
   window.publishPacket({method:'display_image',image_url:source,caption:'Same source'});
   window.publish('## Applying the loop\n\n![Figure](<'+source+'>)\n\nThe explanation stays readable without another copy of the figure.');
 });
 await page.waitForFunction(()=>document.querySelector('#feed img.board-image')?.naturalWidth>0);
 assert.equal(await page.locator('#feed img.board-image').count(),1);
 assert.match(await page.locator('#feed').innerText(),/Observe the situation/);
 assert.match(await page.locator('#feed').innerText(),/explanation stays readable/);
 for(const width of [1365,420]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'image overflow at '+width);
   await page.evaluate(()=>window.notebookScroller().scrollTop=0);
   if(width<900)await page.locator('#feed article').first().scrollIntoViewIfNeeded();
   await page.screenshot({path:join(output,'instructor-single-image-'+width+'.png')});
 }
 await page.locator('#message').fill('Please show this diagram again.');await page.locator('#send').click();
 await page.waitForFunction(()=>window.chat.length===1);
 await page.evaluate(()=>{
   const source='https://lesson-images.invalid/loop.svg';
   window.publish('![Revisit]('+source+')\n\n![Repeated](<'+source+'>)\n\nFollow the arrows again.');
   window.publishPacket({method:'draw_svg',image_url:source});
 });
 assert.equal(await page.locator('#feed img.board-image').count(),2,'one intentional repeat');
 assert.deepEqual(errors,[]);
 writeFileSync(join(output,'result.json'),JSON.stringify({fixtures:true,layouts:[1600,1365,1200,1024,768,420],pages:['room','doubt-selection','doubt-room','catalog','certificates'],checks:['no horizontal overflow','keyboard resize and collapse','draft preserved','run output visible','same-context message sent','dark theme','wheel and keyboard history scrolling','incoming replies preserve reading position','latest reply visible at narrow widths','Doubt Solver uses full width','separate searchable course selection','draft preserved while selecting','attachments and speaker controls','locked and expired chapter access','cross-course selection','selection reload after failure','separate titled chat history','missing ScriptedModel blocks Run','reading-only snippets have no Run','mixed image deliveries render once','requested image revisit renders once'],errors},null,2));
 console.log('Desktop workspace, Doubt Solver selection/room, catalog and certificate layouts passed. Artifacts: '+output);
 }finally{await browser.close();rmSync(storage,{recursive:true,force:true});server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
