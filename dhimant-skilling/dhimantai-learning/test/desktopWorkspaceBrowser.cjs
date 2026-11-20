// Actual host templates and compiled webviews, with local deterministic learning data.
const {join}=require('node:path');
const {writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const {startFixtures}=require('./webviewFixtures.cjs');
let origin,output;
async function checkCoursePreviews(page) {
 await page.goto(origin+'/previews');
 await page.locator('#filter-status').selectOption('preview');
 assert.equal(await page.locator('#results .course:visible').count(),2);
 for(const [id, wrong, right, width] of [
   ['algorithms-python','4','15',1200],
   ['python-backend-fastapi','201 Created','422 Unprocessable Entity',390],
 ]) {
   await page.setViewportSize({width,height:800});
   const entry=page.locator(`[data-course="${id}"] .preview-entry`);
   await entry.focus();
   await page.keyboard.press('Enter');
   const dialog=page.getByRole('dialog');
   await dialog.getByRole('button',{name:wrong,exact:true}).click();
   assert.equal(await dialog.locator('[role=status]').getAttribute('data-correct'),'false');
   assert.ok((await dialog.locator('[role=status]').innerText()).length);
   await dialog.getByRole('button',{name:right,exact:true}).click();
   assert.match(await dialog.locator('[role=status]').innerText(),/^Correct\./);
   assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
   assert.deepEqual(await page.evaluate(()=>window.posts),[]);
   await dialog.screenshot({path:join(output,id+'-preview.png')});
   await page.keyboard.press('Escape');
   assert.equal(await entry.evaluate(el=>document.activeElement===el),true);
   await entry.click();
   assert.equal(await dialog.locator('[role=status]').innerText(),'');
   if(id==='algorithms-python') await dialog.getByRole('button',{name:'Close preview'}).click();
   else {
     await dialog.getByRole('button',{name:'Start free'}).click();
     assert.deepEqual(await page.evaluate(()=>window.posts),[{type:'signUp',id}]);
   }
 }
}

async function checkSolutionLayout(page) {
 await page.goto(origin+'/room');
 await page.locator('#lesson-course option').first().waitFor({state:'attached'});
 const fastapi = require('../../../website/upskill/catalog.json').courses.find(c=>c.id==='python-backend-fastapi');
 const course = {name:fastapi.title,chapters:fastapi.chapters.map((name,i)=>({id:'fastapi-'+i,name,
   progress:{status:i?'not_started':'in_progress',covered:i?0:1,total:4,topics:[]}}))};
 await page.evaluate(course=>window.fixturePost({type:'tutorLessons',attempt:window.posts.find(m=>m.type==='tutorLessons').attempt,courses:[course]}),course);
 await page.getByRole('button',{name:course.chapters[0].name,exact:true}).click();
 await page.waitForFunction(()=>window.rooms.length && document.getElementById('status').textContent.includes('connected'));
 await page.evaluate(()=>{
   const question='Return sorted, unique field names that are required in the new version of an API and were optional or absent in the old version.';
   window.publishPacket({method:'display_on_screen', content:'## Find breaking required-field changes\n\n'+question+'\n\n**Example**\n\n```python\nnew_requirements(["id"], ["id", "name"])\n# ["name"]\n```',
     is_question_prompt:true,tutor_checkpoint_id:'contracts-check',tutor_practice_editor:{question_id:'required-fields',checkpoint_id:'contracts-check',
       language:'python',starter:'def new_requirements(old, new):\n    pass',question,source:'Textbook exercise'}});
 });
 const brief=page.locator('.exercise-instructions'),solution=page.locator('.exercise-solution');
 await solution.locator('.cm-content').fill('def new_requirements(old, new):\n    return sorted(set(new) - set(old))');
 for(const width of [1280,390]) {
   await page.setViewportSize({width,height:width>1000?1050:800});
   const a=await brief.boundingBox(),b=await solution.boundingBox();
   assert.ok(width>1000 ? b.x>=a.x+a.width && Math.abs(a.y-b.y)<2 : b.y>=a.y+a.height,'instructions and editor at '+width);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.evaluate(()=>window.notebookScroller().scrollTop=0);
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   if (width===1280) await page.screenshot({path:join(output,'fastapi-instructor-room.png')});
   await page.locator('.exercise-workspace').screenshot({path:join(output,'exercise-workspace-'+width+'.png')});
   await brief.locator('summary').click();
   assert.equal(await brief.locator('pre').isVisible(),false);
   assert.match(await solution.locator('.cm-content').innerText(),/return sorted/);
   await brief.locator('summary').click();
 }
 await solution.locator('[data-action="run"]').click();
 await solution.locator('.practice-output').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.posts.filter(m=>m.type==='codeAction' && m.action==='run').at(-1).source),
   'def new_requirements(old, new):\n    return sorted(set(new) - set(old))');
}
async function checkRoomNavigation(page) {
 const python = require('../../../website/upskill/catalog.json').courses.find(c=>c.id==='algorithms-python');
 const chapters = python.chapters.map((name,i)=>({id:'algorithm-'+i,name,locked:i===1}));
 await page.goto(origin+'/room');
 await page.locator('#lesson-course option').first().waitFor({state:'attached'});
 await page.evaluate(course=>window.fixturePost({type:'tutorLessons',attempt:window.posts.find(m=>m.type==='tutorLessons').attempt,courses:[course]}),{name:python.title,chapters});
 await page.locator('#lesson-search').fill('Merge Sort');
 await page.evaluate(()=>window.fixturePost({type:'browseCoursePractice'}));
 await page.getByRole('heading',{name:'Chapter exercises'}).waitFor();
 await page.getByRole('button',{name:'Back to chapters'}).click();
 assert.equal(await page.locator('#lesson-search').inputValue(),'Merge Sort');
 assert.equal(await page.locator('#selection-title').evaluate(el=>el===document.activeElement),true);
 await page.getByRole('button',{name:chapters[2].name,exact:true}).click();
 const connected = id=>page.waitForFunction(id=>window.posts.filter(m=>m.type==='join').at(-1)?.chapterId===id && document.getElementById('status').textContent.includes('connected'),id);
 await connected(chapters[2].id);
 await page.locator('#previous-chapter').click();
 await connected(chapters[0].id);
 assert.equal(await page.locator('#previous-chapter').isDisabled(),true);
 assert.match(await page.locator('#skip-chapter').getAttribute('title'),/Merge Sort/);
 await page.evaluate(()=>window.publishPacket({method:'display_on_screen',content:'## Trace the call stack\n\nWhen a recursive call reaches its base case, which call resumes first?',
   is_question_prompt:true,tutor_answer_kind:'written',tutor_checkpoint_id:'recursion-check'}));
 await page.getByRole('button',{name:'Answer this question'}).click();
 assert.equal(await page.locator('#message').evaluate(el=>el===document.activeElement),true);
 await page.locator('#message').fill('The call immediately before the base case resumes first.');
 await page.getByRole('button',{name:'Practice',exact:true}).click();
 const exerciseList={type:'workspacePractice',course:python.title,chapterId:chapters[0].id,chapters,questions:
   ['Flatten a nested list','Flood fill without the call stack','Count the calls a cache saves'].map((title,i)=>({id:'exercise-'+i,title,language:'Python'}))};
 const request=await page.evaluate(()=>window.posts.filter(m=>m.type==='workspacePractice').at(-1).request);
 await page.evaluate(result=>window.fixturePost(result),{...exerciseList,request});
 assert.equal(await page.locator('#practice-list-status').innerText(),'3 exercises');
 assert.equal(await page.locator('#practice-questions button').count(),3);
 await page.setViewportSize({width:1200,height:720});
 await page.screenshot({path:join(output,'algorithms-practice-room.png')});
 await page.getByRole('button',{name:'Back to notebook'}).click();
 await page.evaluate(result=>window.fixturePost(result),{...exerciseList,request});
 assert.equal(await page.locator('#workspace-practice').isVisible(),false);
 assert.equal(await page.locator('#message').inputValue(),'The call immediately before the base case resumes first.');
 assert.equal(await page.locator('#send').getAttribute('aria-label'),'Answer Instructor');
}
async function checkWrittenRoom(page) {
 await page.goto(origin+'/written');
 const brief=page.locator('.written-brief'), answer=page.locator('.written-answer');
 await page.getByLabel('Your work and evidence').fill('Each call resumes after its recursive child returns.');
 for (const width of [1200,390]) {
   await page.setViewportSize({width,height:800});
   const a=await brief.boundingBox(), b=await answer.boundingBox();
   assert.ok(width===1200 ? b.x>=a.x+a.width : b.y>=a.y+a.height,'written practice at '+width);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 await brief.locator('summary').click();
 assert.equal(await page.locator('#task').isVisible(),false);
 await page.getByRole('button',{name:'Back to course'}).click();
 assert.equal(await page.evaluate(()=>window.posts.filter(m=>m.type==='backToCourse').at(-1).answer),'Each call resumes after its recursive child returns.');
}
async function checkLessonStartsHigh(page) {
 await page.goto(origin+'/room');await page.getByRole('button',{name:'Gradients and parameter updates',exact:true}).click();
 await page.waitForFunction(()=>window.rooms.length>0&&document.getElementById('tutor').hidden);
 await page.evaluate(()=>window.publishPacket({method:'display_on_screen',content:'## First exercise\n\nWhat will `sum([2, 5, 3])` return?',is_question_prompt:true,tutor_answer_kind:'written',tutor_checkpoint_id:'first'}));
 for(const [width,height] of [[1440,820],[1280,720],[1024,700]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>window.notebookScroller().scrollTop=0);
   const heading=await page.locator('#feed article h2').first().boundingBox(),composer=await page.locator('#message-bar').boundingBox();
   assert.ok(heading.y<300,'first lesson content starts near the top at '+width+'x'+height+': '+heading.y);
   assert.ok(composer.y+composer.height<=height,'composer stays in view for a short first question at '+width+'x'+height);
   const status=await page.locator('.workspace-status').boundingBox(),title=await page.locator('.workspace-title h1').boundingBox();
   assert.ok(status.y<title.y+title.height,'status sits beside the chapter title at '+width);
   await page.screenshot({path:join(output,'lesson-start-'+width+'.png')});
 }
}
async function checkChapterCards(page) {
 const kafka = require('../../../website/upskill/catalog.json').courses.find(course => course.id === 'apache-kafka');
 const topics = ['What you will build', 'Brokers and KRaft', 'Worked example', 'Live lab', 'Evidence'];
 const chapters = kafka.chapters.map((name, index) => ({
   id: 'kafka-' + index, name, locked: index > 0,
   compute: {status:'specified', totalGpus:0},
   progress: {status:index ? 'not_started' : 'in_progress', covered:0, total:5, needs_review:index ? 0 : 1,
     topics:index ? [] : topics.map((title, i) => ({id:String(i), title, status:i < 2 ? 'in_progress' : 'not_started'}))}
 }));
 await page.locator('#lesson-list button').first().waitFor();
 await page.evaluate(course => window.fixturePost({type:'tutorLessons', browse:true,
   attempt:window.posts.filter(post => post.type === 'tutorLessons').at(-1).attempt, courses:[course]}),
   {name:kafka.title, chapters});
 const cards = page.locator('#lesson-list .lesson-outline');
 assert.equal(await cards.count(), chapters.length);
 for (const [width, columns] of [[1600, 3], [768, 2], [420, 1]]) {
   await page.setViewportSize({width, height:1000});
   const boxes = await cards.evaluateAll(elements => elements.map(card => card.getBoundingClientRect().toJSON()));
   const first = boxes[0];
   const summary = await page.locator('p.course-coverage').boundingBox();
   assert.ok(summary.y + summary.height <= first.top, 'progress summary above Chapter 1 at ' + width);
   assert.ok(Math.abs(first.left - summary.x) < 1, 'Chapter 1 starts in the first column at ' + width);
   const gap = boxes[columns].top - first.bottom;
   assert.ok(gap > 0, 'space between rows at ' + width);
   for (const [i, box] of boxes.entries()) {
     const column = i % columns, row = Math.floor(i / columns);
     assert.ok(Math.abs(box.width - first.width) < 1 && Math.abs(box.height - first.height) < 1, 'equal card dimensions at ' + width);
     assert.ok(Math.abs(box.left - first.left - column * (first.width + gap)) < 1, 'even columns at ' + width);
     assert.ok(Math.abs(box.top - first.top - row * (first.height + gap)) < 1, 'even rows at ' + width);
   }
   assert.ok(await cards.evaluateAll(elements => elements.every(card => {
     const bounds = card.getBoundingClientRect();
     return [...card.querySelectorAll('button, small, li')].filter(child=>child.checkVisibility()).every(child => {
       const box = child.getBoundingClientRect();
       return box.top >= bounds.top && box.bottom <= bounds.bottom && box.left >= bounds.left && box.right <= bounds.right;
     });
   })), 'chapter titles, progress and topics stay inside their cards at ' + width);
   const note = await page.locator('small.course-coverage').boundingBox();
   assert.ok(note.y >= boxes.at(-1).bottom, 'coverage note follows the last row at ' + width);
   await page.screenshot({path:join(output, 'chapter-cards-' + width + '.png')});
 }
}
(async()=>{
 const fixture=await startFixtures();({origin,output}=fixture);const {page,errors}=fixture;
 try{
 await checkCoursePreviews(page);
 await checkSolutionLayout(page);
 await checkRoomNavigation(page);
 await checkWrittenRoom(page);
 await checkLessonStartsHigh(page);
 await page.goto(origin+'/room');
 await checkChapterCards(page);
 await page.setViewportSize({width:1600,height:1000});
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
 await page.locator('#doubt-tried-box summary').click();
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
 writeFileSync(join(output,'result.json'),JSON.stringify({fixtures:true,layouts:[1600,1365,1200,1024,768,420],pages:['room','doubt-selection','doubt-room','catalog','certificates'],checks:['lesson starts near the top with the composer in view','no horizontal overflow','keyboard resize and collapse','draft preserved','run output visible','same-context message sent','dark theme','wheel and keyboard history scrolling','incoming replies preserve reading position','latest reply visible at narrow widths','Doubt Solver uses full width','separate searchable course selection','draft preserved while selecting','attachments and speaker controls','locked and expired chapter access','cross-course selection','selection reload after failure','separate titled chat history','missing ScriptedModel blocks Run','reading-only snippets have no Run','mixed image deliveries render once','requested image revisit renders once'],errors},null,2));
 console.log('Desktop workspace, Doubt Solver selection/room, catalog and certificate layouts passed. Artifacts: '+output);
 }finally{await fixture.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
