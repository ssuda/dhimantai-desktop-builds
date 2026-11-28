// Actual host templates and compiled webviews, with local deterministic learning data.
const {join}=require('node:path');
const {writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const {startFixtures}=require('./webviewFixtures.cjs');
let origin,output;
async function checkAccountLayout(page) {
 for (const mode of ['signIn', 'signUp']) {
   await page.goto(origin + '/' + mode);
   for (const [width, height] of [[1920, 1080], [1280, 600], [760, 800], [759, 800], [390, 700]]) {
     await page.setViewportSize({width, height});
     const panel = await page.locator('.account').boundingBox();
     const form = await page.locator('.form-content').boundingBox();
     assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
     if (width >= 760) {
       assert.ok(panel.x === 0 && panel.y === 0 && panel.width === width && panel.height >= height,
         mode + ' fills the desktop viewport at ' + width);
       assert.ok(form.width <= 480 && Math.abs(form.x + form.width / 2 - width * .75) < 1,
         mode + ' centers a readable form in the right panel');
     } else {
       assert.ok(panel.x > 0 && panel.width <= 540 && Math.abs(panel.x * 2 + panel.width - width) < 1);
       assert.equal(await page.locator('.brand-story').isVisible(), false);
       const brand = await page.locator('.brand-panel').boundingBox();
       assert.ok(form.y >= brand.y + brand.height);
     }
     const submit = page.locator('.submit');
     await submit.scrollIntoViewIfNeeded();
     const button = await submit.boundingBox();
     assert.ok(button.y >= -1 && button.y + button.height <= height + 1, 'submit is reachable at ' + width);
     await page.evaluate(() => scrollTo(0, 0));
     await page.screenshot({path:join(output, mode + '-' + width + '.png'), fullPage:true});
   }
 }
}
async function checkCourseSearch(page, path) {
 const courses = [
   {name:'AI at Work', chapters:[{id:'ai', name:'Using AI'}]},
   {name:'Algorithms with Python', chapters:[{id:'algorithms', name:'Sorting'}]},
   {name:'Data Structures with Python', chapters:[{id:'structures', name:'Stacks'}]},
 ];
 await page.goto(origin + path + '?holdLessons');
 await page.waitForFunction(() => window.posts.some(post => post.type === 'tutorLessons'));
 await page.evaluate(courses => window.fixturePost({type:'tutorLessons', courses,
   attempt:window.posts.find(post => post.type === 'tutorLessons').attempt}), courses);
 const toggle = page.getByRole('button', {name:'Course AI at Work', exact:true});
 const query = page.getByRole('combobox', {name:'Search courses'});
 const options = page.getByRole('listbox', {name:'Courses'}).getByRole('option');
 const chapterSearch = page.getByLabel('Find a chapter');
 await chapterSearch.fill('Using');
 await toggle.click();
 assert.equal(await query.evaluate(field => field === document.activeElement), true);
 assert.deepEqual(await options.allTextContents(), courses.map(course => course.name));
 await query.fill('YtH');
 assert.deepEqual(await options.allTextContents(), courses.slice(1).map(course => course.name));
 await page.locator('#course-selection').screenshot({path:join(output, path.slice(1) + '-course-search.png')});
 assert.ok(await page.getByRole('button', {name:'Using AI', exact:true}).isVisible());
 await query.fill('unknown');
 assert.ok(await page.getByText('No courses match your search.').isVisible());
 await query.press('Enter');
 assert.ok(await query.isVisible());
 await query.press('Escape');
 assert.ok(await toggle.evaluate(button => button === document.activeElement));
 assert.equal(await chapterSearch.inputValue(), 'Using');
 await toggle.press('Enter');
 assert.equal(await query.inputValue(), '');
 assert.equal(await options.count(), courses.length);
 await query.fill('YtH');
 await query.press('ArrowDown');
 await query.press('Enter');
 const selected = page.getByRole('button', {name:'Course Data Structures with Python', exact:true});
 assert.ok(await selected.evaluate(button => button === document.activeElement));
 assert.equal(await chapterSearch.inputValue(), '');
 assert.ok(await page.getByRole('button', {name:'Stacks', exact:true}).isVisible());
 await selected.click();
 await query.fill('rith');
 await chapterSearch.click();
 assert.equal(await query.isVisible(), false);
 await selected.click();
 await query.press('Tab');
 assert.equal(await query.isVisible(), false);
 assert.ok(await chapterSearch.evaluate(field => field === document.activeElement));
 await selected.click();
 await options.filter({hasText:'Algorithms with Python'}).click();
 await page.getByRole('button', {name:'Sorting', exact:true}).click();
 await page.waitForFunction(() => window.posts.some(post => post.type === 'join' && post.chapterId === 'algorithms'));
}

async function checkCoursePreviews(page) {
 await page.goto(origin+'/previews');
 const initialPostCount = await page.evaluate(() => window.posts.length);
 const previewPosts = () => page.evaluate(start => window.posts.slice(start), initialPostCount);
 await page.getByRole('button',{name:'Explore',exact:true}).click();
 if(await page.locator('#toggle-filters').isVisible()) await page.locator('#toggle-filters').click();
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
   assert.deepEqual(await previewPosts(),[]);
   await dialog.screenshot({path:join(output,id+'-preview.png')});
   await page.keyboard.press('Escape');
   assert.equal(await entry.evaluate(el=>document.activeElement===el),true);
   await entry.click();
   assert.equal(await dialog.locator('[role=status]').innerText(),'');
   if(id==='algorithms-python') await dialog.getByRole('button',{name:'Close preview'}).click();
   else {
     await dialog.getByRole('button',{name:'Start chapter 1'}).click();
     assert.deepEqual(await previewPosts(),[{type:'signUp',id}]);
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
async function checkStickyNotebook(page) {
 for (const path of ['/room', '/practice', '/doubt']) {
   await page.goto(origin + path);
   if (path !== '/practice') await page.getByRole('button', {name:'Gradients and parameter updates', exact:true}).click();
   await page.locator('.room-ready').waitFor();
   await page.evaluate(() => {
     window.fixturePost({type:'restoreNotebook', documentKey:'fixture', learnerInitial:'J', notebook:{version:1, title:'Saved notebook', drafts:[], textDraft:'Keep this draft',
       cells:[{kind:'message',id:'question',text:'Please continue the lesson.'},
         ...Array.from({length:28}, (_, i) => ({kind:'board',id:'section-' + i,text:'## Notebook section ' + i + '\n\nRead this passage.'}))]}});
   });
   const student = page.locator('[data-cell-id="question"]'), reply = page.locator('[data-cell-id="section-0"]');
   assert.equal(await student.locator('.speaker-avatar[aria-hidden="true"]').innerText(), 'J');
   assert.equal(await reply.locator('.speaker-name').innerText(), path === '/doubt' ? 'Doubt Solver' : 'Instructor');
   const background = card => card.evaluate(el => getComputedStyle(el).backgroundColor);
   assert.notEqual(await background(student.locator('.learner-message')), await background(reply));
   const options = page.getByLabel('Notebook options', {exact:true});
   await page.locator('#notebook-edges').waitFor();
   let previousGutter = 0;
   for (const width of [1440, 1920, 390, 320]) {
     await page.setViewportSize({width,height:720});
     const composer = await page.locator('.composer-box').boundingBox(), card = await reply.boundingBox();
     assert.ok(Math.abs(card.x + card.width - composer.x - composer.width) < 2,
       path + ' reply and composer share a right edge at ' + width);
     if (width >= 1440) {
       const header = await page.locator('.workspace-topline').boundingBox();
       const avatar = await reply.locator('.speaker-avatar').boundingBox();
       const bubble = await student.boundingBox();
       const studentAvatar = await student.locator('.speaker-avatar').boundingBox();
       const paragraph = await reply.locator('.conversation-body p').first().boundingBox();
       const right = card.x + card.width;
       assert.ok(card.width > width * .85 && Math.abs(card.x - composer.x) < 2);
       assert.ok(paragraph.width > card.width * .9, 'reply text uses the width of its card');
       assert.ok(header.x > previousGutter && Math.abs(width - right - header.x) < 2, 'both room gutters grow with the window');
       assert.ok(avatar.x >= header.x && avatar.x + avatar.width <= card.x, 'the reply avatar fits inside the left gutter of the conversation');
       assert.ok(bubble.width < card.width / 2 && Math.abs(studentAvatar.x + studentAvatar.width - right) < 2);
       previousGutter = header.x;
     }
     await page.getByRole('button',{name:'Bottom of notebook'}).click();
     await page.waitForFunction(() => {
       const page = window.notebookScroller();
       return Math.abs(page.scrollHeight - page.clientHeight - page.scrollTop) < 2;
     });
     assert.equal(await page.locator('#message').inputValue(), 'Keep this draft');
     const bar = page.getByRole('navigation', {name:'Learning notebook controls'});
     const box = await bar.boundingBox();
     assert.ok(box && Math.abs(box.y) < 1 && box.height <= (width > 1000 ? 65 : 105), path+' toolbar at '+width+': '+JSON.stringify(box));
     assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
     for (const id of ['#workspace-mode', '#coaching-language', '#course-runtime']) {
       const rect = await page.locator(id).boundingBox();
       assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= box.height + 1, id+' at '+width);
     }
     if (!await page.locator('#course-notes').isVisible()) await options.click();
     for (const id of ['#add-code', '#add-note', '#course-notes']) assert.equal(await page.locator(id).isVisible(), true);
     await page.locator('#course-notes').click();
     assert.ok(await page.evaluate(() => window.posts.some(m => m.type === 'courseNotes' && m.documentKey === 'fixture')));
     await options.click();
     await page.locator('#saved-practice').click();
     assert.equal(await options.evaluate(el => el === document.activeElement), true);
     assert.ok(await page.evaluate(() => window.posts.some(m => m.type === 'savedPracticeNotebooks')));
     await page.getByRole('button',{name:'Top of notebook'}).focus();
     await page.keyboard.press('Enter');
     assert.equal(await page.evaluate(() => window.notebookScroller().scrollTop), 0);
     assert.equal(await page.locator('.workspace-title h1').evaluate(el => el === document.activeElement), true);
     await page.evaluate(() => { window.notebookScroller().scrollTop = 800; });
     await page.screenshot({path:join(output, path.slice(1)+'-toolbar-'+width+'.png')});
   }
   await options.click();
   await page.locator('#add-code').click();
   await page.locator('#feed article[data-entry-kind="code"]').last().waitFor();
   await options.click();
   await page.locator('#add-note').click();
   assert.equal(await page.getByRole('textbox',{name:'My notes'}).last().inputValue(), 'Keep this draft');
   await page.setViewportSize({width:1440, height:1600});
   await page.evaluate(() => window.fixturePost({type:'restoreNotebook', documentKey:'fixture',
     notebook:{version:1, title:'Short notebook', drafts:[], cells:[]}}));
   await page.locator('#notebook-edges').waitFor({state:'hidden'});
 }
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
 await page.getByLabel('Notebook options', {exact:true}).click();
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
 await page.evaluate(()=>window.fixturePost({type:'feedback', feedback:'Check the base case.', next_step:'Trace one return.'}));
 const feedback = page.locator('.written-feedback');
 assert.equal(await feedback.locator('.speaker-name').innerText(), 'Instructor');
 assert.match(await feedback.locator('.speaker-avatar').evaluate(el=>getComputedStyle(el).backgroundImage), /dhimantai-avatar/);
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
 // Pass the installed or unpacked VSIX directory to exercise the assets learners receive.
 const packagedLayout = process.argv[2] === '--layout-from';
 if (packagedLayout) assert.ok(process.argv[3], '--layout-from requires an extension directory');
 const fixture=await startFixtures(packagedLayout ? process.argv[3] : undefined);({origin,output}=fixture);const {page,errors}=fixture;
 try{
 if (packagedLayout) {
   await checkAccountLayout(page);
   await checkStickyNotebook(page);
   assert.deepEqual(errors, []);
   console.log('Packaged account and learning chat layouts passed.');
   return;
 }
 for (const path of ['/room', '/doubt']) {
   await checkCourseSearch(page, path);
   await page.goto(origin + path + '?holdLessons');
   await page.waitForFunction(() => window.posts.some(m => m.type === 'tutorLessons'));
   assert.ok(await page.locator('#lesson-loading[role=status]').isVisible());
   assert.equal(await page.locator('#course-selection').isVisible(), false);
   assert.equal(await page.locator('#learning-workspace').isVisible(), false);
   await page.evaluate(() => {
     window.fixturePost({type:'visibility', visible:false});
     window.fixturePost({type:'visibility', visible:true});
   });
   assert.equal(await page.evaluate(() => window.posts.filter(m => m.type === 'tutorLessons').length), 1);
   if (path === '/doubt') {
     await page.evaluate(() => window.fixturePost({type:'tutorLessons', attempt:window.posts.findLast(m => m.type === 'tutorLessons').attempt, error:'Connection lost.'}));
     await page.getByRole('button', {name:'Retry loading courses'}).click();
     assert.ok(await page.locator('#lesson-loading').isVisible());
   }
   await page.evaluate(() => window.fixturePost({type:'tutorLessons', attempt:window.posts.findLast(m => m.type === 'tutorLessons').attempt,
     preferredCourse:'Python', courses:[{name:'Python', chapters:[{id:'lists', name:'Lists'}]}]}));
   await page.locator('#lesson-loading').waitFor({state:'hidden'});
   if (path === '/doubt') await page.getByRole('button', {name:'Lists', exact:true}).click();
   await page.locator('#learning-workspace').waitFor({state:'visible'});
   assert.equal(await page.locator('#course-selection').isVisible(), false);
 }
 await checkStickyNotebook(page);
 await checkAccountLayout(page);
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
   assert.ok(await page.evaluate(() => {
     const feed=document.getElementById('feed').getBoundingClientRect(), composer=document.getElementById('message-bar').getBoundingClientRect();
     return composer.top >= feed.bottom - 1 && Math.abs(composer.width - feed.width) < 2;
   }), 'composer follows the full-width notebook at '+width);
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
   await page.getByLabel('Notebook options', {exact:true}).click();
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
   assert.ok(documentBox.width >= width * .90,'Doubt Solver uses the available room width');
   assert.equal(await page.locator('#message-bar').evaluate(el=>el.parentElement.id),'learning-document');
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.screenshot({path:join(output,'doubt-room-'+width+'.png')});
   await page.locator('#message').scrollIntoViewIfNeeded();
   await page.screenshot({path:join(output,'doubt-composer-'+width+'.png')});
 }
 await page.locator('#choose-course').click();
 await page.waitForFunction(()=>document.getElementById('lesson-list').getAttribute('aria-busy')==='false');
 await page.locator('#course-toggle').click();
 await page.getByRole('option', {name:'Python', exact:true}).click();
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
 await page.getByLabel('Notebook options', {exact:true}).click();
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
