// Set DHIMANTAI_POSTGRES_NOTEBOOK_IMAGE and DHIMANTAI_DB2_NOTEBOOK_IMAGE to local course images.
// For MySQL, IRB, Rust and Go too, set DHIMANTAI_TERMINAL_TEST_CONTAINER to a disposable course
// container with those clients, a working MySQL login, and media/course at /tmp/terminal-bridge.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {join} = require('node:path');
const {startFixtures, root} = require('./webviewFixtures.cjs');
const {NotebookCells} = require('../out/src/notebookCells');
const {terminalClosedMessage, terminalPrograms} = require('../out/src/notebookTerminal');
const {RoomCodeSession} = require('../out/src/roomCode');

async function check() {
  const image = process.env.DHIMANTAI_POSTGRES_NOTEBOOK_IMAGE;
  assert.ok(image, 'Set DHIMANTAI_POSTGRES_NOTEBOOK_IMAGE to a local DBA course image');
  const fixtureContainer = process.env.DHIMANTAI_TERMINAL_TEST_CONTAINER;
  const db2Image = process.env.DHIMANTAI_DB2_NOTEBOOK_IMAGE;
  assert.ok(db2Image, 'Set DHIMANTAI_DB2_NOTEBOOK_IMAGE to the local Db2 course image');
  const createCells = (documentKey) => {
    const shell = documentKey === 'shell' || documentKey === 'optional';
    const selectedImage = shell ? process.env.DHIMANTAI_ZSH_NOTEBOOK_IMAGE || db2Image : documentKey === 'db2' ? db2Image : image;
    const args = shell ? ['-v',join(root,'media/course/zshrc')+':/home/learner/.zshrc:ro','--env','HOME=/home/learner'] : [];
    const command = fixtureContainer && !shell && documentKey !== 'db2'
      ? ['exec','-i','--workdir=/tmp',fixtureContainer,'python3','-u','/tmp/terminal-bridge/cells.py']
      : ['run','--rm','-i','--network=none','--workdir=/tmp','-v',join(root,'media/course')+':/bridge:ro',
        ...args,'--entrypoint=python3',selectedImage,'-u','/bridge/cells.py'];
    return new NotebookCells(() => ({}), undefined, undefined, 60000, {
      target:'Test course container', start:async () => spawn(process.env.DHIMANTAI_CONTAINER_ENGINE || 'docker',command),
    });
  };
  const cells = createCells(), clients = new Map(), typed = new Set();
  let terminalRun;
  const session = new RoomCodeSession({current:async () => true, aiEnabled:() => false,
    run:(snapshot,signal,event) => cells.run(snapshot.language,snapshot.source,snapshot.stdin,
      {database:'lab',interactive:snapshot.interactive,terminal:true,signal,event})});
  const {page, origin, errors, close} = await startFixtures();
  try {
    const messages = [];
    let delivery = Promise.resolve();
    await page.exposeFunction('courseTerminalControl', async m => {
      if (m.type === 'codeAction') await session.handle(m, result => {
        if (result.execution) messages.push(result.execution);
        delivery = delivery.then(() => page.evaluate(packet => window.fixturePost(packet), result));
      });
      else if (m.type === 'notebookTerminal' && m.action === 'connect') {
        const key=m.documentKey+':'+m.cell, client=createCells(m.documentKey); clients.set(key,client);
        const notify = packet => {delivery=delivery.then(()=>page.evaluate(message=>window.fixturePost(message),
          {type:'notebookTerminal',documentKey:m.documentKey,cell:m.cell,...packet}));};
        try {
          terminalRun = client.run('bash',terminalPrograms[m.program].command,'',{interactive:true,terminal:true,
            ...(m.program === 'psql' ? {database:'lab'} : {}),
            event:event=>{if(event.kind==='terminal')notify({id:event.id,data:event.data});}});
          const result=await terminalRun;
          notify({closed:true,error:terminalClosedMessage(terminalPrograms[m.program].label,result.exit_code,result.stderr,typed.has(key))});
        } finally {
          if (clients.get(key) === client) {clients.delete(key); typed.delete(key);}
          await client.close();
        }
      }
      else if (m.type === 'notebookTerminal' && m.action === 'input') {
        if ('data' in m.control) typed.add(m.documentKey+':'+m.cell);
        clients.get(m.documentKey+':'+m.cell)?.terminal(m.id,m.control);
      }
      else if (m.type === 'notebookTerminal' && m.action === 'close') clients.get(m.documentKey+':'+m.cell)?.restart();
      else if (m.action === 'terminal') cells.terminal(m.id, m.control);
      else if (m.action === 'stop') session.stop();
    });
    await page.goto(origin + '/room');
    await page.getByRole('button',{name:'Gradients and parameter updates',exact:true}).click();
    await page.waitForFunction(() => window.rooms.length && document.getElementById('tutor').hidden);
    await page.evaluate(() => window.fixturePost({type:'restoreNotebook', documentKey:'original-script',
      notebook:{version:1,title:'Shell scripts',cells:[{id:'my-script',kind:'code',text:'psql -d postgres',packet:{language:'bash'}}],drafts:[]}}));
    const cell = page.locator('.practice-code-editor').first();
    const buffer = cell.locator('.practice-buffer');
    await buffer.locator('.cm-content').press('Enter');
    const screen = buffer.locator('.xterm-rows');
    const expectScreen = text => page.waitForFunction(expected =>
      [...document.querySelectorAll('.xterm-rows')].some(rows => rows.textContent.replaceAll('\u00a0',' ').includes(expected)), text, {timeout:15000});
    await expectScreen('postgres=#');
    assert.ok(await buffer.locator('.xterm-helper-textarea').evaluate(el => document.activeElement === el));
    assert.ok(await buffer.isVisible());
    assert.equal(await cell.locator(':scope > .execution-result').isVisible(), false);
    assert.equal(await buffer.locator('.cm-content').isVisible(), false);
    assert.equal(await cell.getByRole('button',{name:/^(Send input|End input)$/}).count(), 0);
    await page.keyboard.type('SEL');
    await page.keyboard.press('Tab');
    await expectScreen('SELECT');
    await page.keyboard.type('40 +');
    await page.keyboard.press('Enter');
    await expectScreen('postgres-#');
    await page.keyboard.type('2 AS answer;');
    await page.keyboard.press('Enter');
    await expectScreen('42');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent
      .replaceAll('\u00a0',' ').match(/postgres=# SELECT 40/g) ?? []).length === 2);
    await page.keyboard.press('Control+c');
    await page.keyboard.type('SELECT pg_sleep(20);');
    await page.keyboard.press('Enter');
    await expectScreen('pg_sleep');
    await page.keyboard.press('Control+c');
    await expectScreen('canceling statement');
    await page.setViewportSize({width:560,height:800});
    await page.keyboard.type('\\conninfo');
    await page.keyboard.press('Enter');
    await expectScreen('connected to database');
    assert.ok(await cell.locator('.cell-terminal').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.keyboard.press('Control+d');
    await screen.waitFor({state:'detached',timeout:15000});
    await delivery;
    assert.equal(messages[0]?.exit_code, 0);
    assert.match(messages[0].stdout, /42/);
    assert.doesNotMatch(messages[0].stdout, /[\x1b\x08]/);
    assert.equal(await cell.locator('.cm-content').evaluate(el => document.activeElement === el), true);
    await page.evaluate(() => window.fixturePost({type:'restoreNotebook', documentKey:'dba',
      terminal:'postgres',codeLanguage:'sql',notebook:{version:1,title:'PostgreSQL Administration (DBA)',cells:[],drafts:[]}}));
    const sql='SELECT 42 AS example_answer;';
    await page.evaluate(source=>window.publish('Read this query.\n\n```sql\n'+source+'\n```'),sql);
    await page.locator('.instructor-commands').getByText(sql).waitFor();
    assert.equal(await page.locator('.notebook-terminal-cell, .practice-code-editor').count(),0);
    await page.evaluate(()=>window.publishPacket({method:'display_on_screen',content:'Run the query in psql.',tutor_terminal_action:'run'}));
    const example=page.getByRole('region',{name:'PostgreSQL (psql) terminal'});
    await example.scrollIntoViewIfNeeded();
    await expectScreen('=#');
    await example.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(sql); await page.keyboard.press('Enter');
    await expectScreen('(1 row)');
    await page.keyboard.type('\\q'); await page.keyboard.press('Enter');
    await example.getByRole('button',{name:'Reconnect to PostgreSQL'}).waitFor();
    const oldCode = {id:'old-bash',kind:'code',text:'pwd',packet:{language:'bash'}};
    const progress = {id:'chapter-progress',kind:'recap',text:'### Lesson progress'};
    const lesson = {id:'first-explanation',kind:'board',text:'### Start with a real situation'};
    const book = {version:1,title:'Terminal and Linux Basics',cells:[progress,oldCode],drafts:[]};
    await page.goto(origin + '/room?holdLessons');
    await page.waitForFunction(() => window.posts.some(m => m.type === 'tutorLessons'));
    await page.evaluate(notebook => {
      window.fixtureLessonNotebook = {documentKey:'shell',terminal:'zsh',autoOpenTerminal:true,codeLanguage:'bash',notebook};
      const request = window.posts.findLast(m => m.type === 'tutorLessons');
      window.fixturePost({type:'tutorLessons',attempt:request.attempt,courses:[
        {name:'Terminal and Linux Basics',chapters:[{id:'shell-intro',name:'Shell navigation'}]}]});
    },book);
    await page.getByRole('button',{name:'Shell navigation',exact:true}).click();
    const zsh = page.getByRole('region',{name:'Zsh terminal',exact:true});
    await page.locator('#feed > [data-cell-id="old-bash"]').waitFor();
    assert.equal(await zsh.count(),0,'a recap and learner code cannot open the automatic terminal');
    await page.evaluate(()=>window.publishPacket({method:'display_on_screen',content:'Waiting for the next step.',operational_notice:true}));
    assert.equal(await zsh.count(),0);
    assert.equal(await page.evaluate(()=>window.posts.filter(m=>m.type==='notebookTerminal' && m.action==='connect' && m.documentKey==='shell').length),0);
    await page.evaluate(text=>window.publish(text),lesson.text);
    const question = 'In ~/linux-lab, you run two commands.\n\n```bash\ncat hello.sh\n./hello.sh\n```\nThe first prints the file. The second reports permission denied. Explain why.';
    await page.evaluate(content=>window.publishPacket({method:'display_on_screen',content,is_question_prompt:true,tutor_answer_kind:'written',tutor_checkpoint_id:'permissions'}),question);
    const reading=page.locator('article[data-entry-kind=question]').last();
    assert.equal(await reading.locator('.instructor-commands code').textContent(),'cat hello.sh\n./hello.sh');
    assert.equal(await reading.locator('.code-block-card,.practice-code-editor,.notebook-terminal-cell,[data-copy-code]').count(),0);
    assert.equal(await zsh.count(),0);
    await page.evaluate(()=>window.publishPacket({method:'display_on_screen',content:'Create a folder in your course terminal.',tutor_terminal_action:'create'}));
    await zsh.scrollIntoViewIfNeeded();
    await expectScreen('/tmp $');
    const input = zsh.locator('.xterm-helper-textarea');
    const cellOrder = () => page.locator('#feed > article').evaluateAll(rows => rows.map(row => row.dataset.cellId));
    assert.deepEqual((await cellOrder()).slice(0,2),['chapter-progress','old-bash']);
    assert.equal(await zsh.evaluate(el=>el.closest('article').previousElementSibling.textContent.includes('Create a folder')),true);
    assert.equal(await input.evaluate(el => document.activeElement === el), false);
    await input.focus();
    await page.keyboard.type('[[ -o login && -o interactive ]] && (( $+functions[omz] && $+aliases[gst] )) && print -r -- "$ZSH"');
    await page.keyboard.press('Enter');
    await expectScreen('/opt/oh-my-zsh');
    await page.keyboard.type('mkdir -p example && cd example && export ANSWER=42');
    await page.keyboard.press('Enter');
    await expectScreen('/tmp/example $');
    const liveShell = await zsh.elementHandle();
    await page.keyboard.type('echo value=');
    await page.evaluate(()=>window.publish('### Inspect your working directory\n\nThe shell remembers the directory and your variables.'));
    assert.equal(await page.locator('#feed > article:last-child').getAttribute('data-entry-kind'),'lesson');
    assert.ok(await zsh.evaluate((el, previous)=>el===previous,liveShell));
    assert.ok(await input.evaluate(el=>document.activeElement===el));
    await page.keyboard.type('$ANSWER');
    await page.keyboard.press('Enter');
    await expectScreen('value=42');
    await page.setViewportSize({width:1440,height:920});
    await input.focus();
    assert.equal(await zsh.count(),1);
    assert.ok(await input.evaluate(el => document.activeElement === el));
    for (const width of [1440,480]) {
      await page.setViewportSize({width,height:920});
      await page.waitForFunction(()=>{
        const frame=document.querySelector('#feed > article[data-entry-kind=terminal] .cell-terminal'), rows=frame?.querySelector('.xterm-rows');
        if (!frame || !rows) return false;
        const outer=frame.getBoundingClientRect(), text=rows.getBoundingClientRect();
        return text.height>0 && text.bottom<=outer.bottom && text.right<=outer.right+1;
      });
      const geometry = await zsh.evaluate(el => {
        const terminal = el.closest('article'), shell = el.querySelector('.cell-terminal'), lesson = terminal.previousElementSibling;
        const header=terminal.querySelector('.terminal-heading'), picker=header.querySelector('select');
        return {rightInset:terminal.getBoundingClientRect().right-picker.getBoundingClientRect().right,
          outerRule:getComputedStyle(terminal).borderLeftWidth,divider:getComputedStyle(header).borderBottomWidth,
          height:shell.clientHeight,resize:getComputedStyle(shell).resize,overflow:terminal.scrollWidth-terminal.clientWidth,
          sameBackground:getComputedStyle(shell).backgroundColor===getComputedStyle(el.querySelector('.xterm-viewport')).backgroundColor,
          inset:Math.abs(terminal.getBoundingClientRect().left-lesson.getBoundingClientRect().left)};
      });
      assert.ok(geometry.height >= 96 && geometry.height <= 165,JSON.stringify(geometry));
      assert.ok(geometry.rightInset>=8 && geometry.rightInset<=16,JSON.stringify(geometry));
      assert.equal(geometry.outerRule,'1px');
      assert.equal(geometry.divider,'1px');
      assert.equal(geometry.resize,'vertical');
      assert.ok(geometry.sameBackground,'the renderer gutter follows the terminal theme');
      assert.ok(geometry.inset <= 1 && geometry.overflow <= 1,JSON.stringify(geometry));
    }
    await page.setViewportSize({width:1440,height:920});
    const savedZsh = await page.evaluate(() => {
      document.getElementById('save-notebook').click();
      return window.posts.filter(message => message.type === 'exportNotebook').at(-1).notebook;
    });
    const starter = {id:'zsh-console',kind:'terminal',text:'',packet:{language:'zsh'}};
    assert.deepEqual(savedZsh.cells.map(cell=>cell.kind),['recap','code','board','board','board','board','terminal','board']);
    assert.equal(savedZsh.cells.at(-2).packet.language,'zsh');
    assert.equal(await page.locator('article[data-entry-kind=code] .cm-content').textContent(), 'pwd');
    await page.keyboard.press('Control+d');
    await zsh.getByRole('button',{name:'Restart Zsh'}).click();
    await expectScreen('/tmp $');
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await zsh.getByRole('button',{name:'Restart Zsh'}).waitFor();
    await page.evaluate(notebook => window.fixturePost({type:'restoreNotebook',documentKey:'shell',
      terminal:'zsh',autoOpenTerminal:true,codeLanguage:'bash',notebook}),{...savedZsh,cells:[progress,starter,lesson,oldCode]});
    assert.equal(await zsh.count(),0);
    assert.deepEqual(await cellOrder(), ['chapter-progress','first-explanation','old-bash']);
    await page.evaluate(notebook => window.fixturePost({type:'restoreNotebook',documentKey:'shell',terminal:'zsh',notebook}),savedZsh);
    assert.deepEqual(await cellOrder(),savedZsh.cells.map(cell=>cell.id));
    assert.equal(await zsh.count(),1);
    await page.evaluate(() => window.fixturePost({type:'restoreNotebook',documentKey:'optional',
      terminal:'zsh',autoOpenTerminal:false,codeLanguage:'python',notebook:{version:1,title:'VS Code for Everyday Engineering',cells:[],drafts:[]}}));
    assert.equal(await zsh.count(),0);
    await page.locator('#terminal-cell').click();
    await expectScreen('/tmp $');
    await zsh.locator('.xterm-helper-textarea').press('Control+d');
    await zsh.getByRole('button',{name:'Restart Zsh'}).waitFor();

    await page.evaluate(() => window.fixturePost({type:'restoreNotebook',documentKey:'db2',
      terminal:'db2',autoOpenTerminal:true,codeLanguage:'python',notebook:{version:1,title:'IBM Db2 LUW Administration (DBA)',cells:[],drafts:[]}}));
    const db2Cell=page.getByRole('region',{name:'IBM Db2 terminal'});
    const opening = page.locator('#chapter-proficiency');
    await opening.waitFor({state:'visible'});
    assert.equal(await db2Cell.count(),0);
    await page.evaluate(() => window.publish('Read this query.\n\n```sql\nVALUES CURRENT SERVER;\n```'));
    await page.locator('.instructor-commands').filter({hasText:'VALUES CURRENT SERVER;'}).waitFor();
    assert.equal(await db2Cell.count(),0);
    await page.evaluate(()=>window.publishPacket({method:'display_on_screen',content:'Connect to your Db2 lab and run the query.',tutor_terminal_action:'run'}));
    await expectScreen('SSH login (user@host or SSH alias)');
    assert.equal(await db2Cell.evaluate(el=>el.contains(document.activeElement)),false);
    await db2Cell.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('-bad'); await page.keyboard.press('Enter');
    await expectScreen('Enter a user@host or an SSH host alias');
    assert.equal((await terminalRun).exit_code,2);
    await db2Cell.getByRole('button',{name:'Restart IBM Db2'}).click();
    await expectScreen('SSH login (user@host or SSH alias)');
    await page.keyboard.type('learner@127.0.0.1'); await page.keyboard.press('Enter');
    await expectScreen('Connection refused');
    assert.equal((await terminalRun).exit_code,255);
    const db2Before = await db2Cell.elementHandle();
    await page.evaluate(() => window.publish('Now check the output.'));
    assert.equal(await page.locator('.practice-code-editor').count(),0);
    assert.equal(await opening.isVisible(),false);
    assert.deepEqual(await page.locator('#feed > article').evaluateAll(rows=>rows.map(row=>row.dataset.entryKind)),['lesson','lesson','terminal','lesson']);
    assert.ok(await db2Cell.evaluate((el, previous)=>el===previous,db2Before));
    await page.evaluate(()=>document.getElementById('add-note').click());
    assert.deepEqual(await page.locator('#feed > article').evaluateAll(rows=>rows.map(row=>row.dataset.entryKind)),['lesson','lesson','terminal','lesson','note']);
    const savedDb2 = await page.evaluate(() => {
      document.getElementById('save-notebook').click();
      return window.posts.findLast(m => m.type==='exportNotebook').notebook;
    });
    assert.deepEqual(savedDb2.cells.map(cell=>cell.kind),['board','board','terminal','board','note']);
    // Keep a saved starter's selected program at its saved position.
    const switched = {...starter,packet:{language:'db2',terminalTypeSelected:true}};
    await page.evaluate(notebook=>window.fixturePost({type:'restoreNotebook',documentKey:'shell',terminal:'zsh',autoOpenTerminal:true,notebook}),
      {...book,cells:[progress,switched]});
    assert.equal(await db2Cell.count(),1);
    await page.evaluate(()=>window.publish('The shell interprets the command.'));
    await db2Cell.waitFor();
    assert.deepEqual(await page.locator('#feed > article').evaluateAll(rows=>rows.map(row=>row.dataset.entryKind)),['recap','terminal','lesson']);
    assert.equal(await db2Cell.locator('xpath=ancestor::article').getByLabel('Terminal type').inputValue(),'db2');
    // A manually opened terminal stays in place during later explanations.
    await page.evaluate(notebook=>window.fixturePost({type:'restoreNotebook',documentKey:'shell',terminal:'zsh',autoOpenTerminal:true,notebook}),{...book,cells:[progress]});
    await page.locator('#terminal-cell').click();
    await zsh.waitFor();
    await page.evaluate(()=>window.publish('Now run pwd in your shell.'));
    assert.equal(await zsh.count(),1);
    assert.deepEqual(await page.locator('#feed > article').evaluateAll(rows=>rows.map(row=>row.dataset.entryKind)),['recap','terminal','lesson']);
    await page.evaluate(() => window.fixturePost({type:'restoreNotebook', documentKey:'python',
      notebook:{version:1,title:'Python',cells:[],drafts:[]}}));
    await page.setViewportSize({width:1350,height:900});
    await page.locator('#terminal-cell').click();
    const row = page.locator('article[data-entry-kind=terminal]').last(), picker = row.getByLabel('Terminal type');
    assert.equal(await picker.inputValue(),'bash');
    assert.deepEqual(await picker.locator('option').evaluateAll(options=>options.map(o=>o.value).sort()),Object.keys(terminalPrograms).sort());
    const enter = async (command, output) => {
      const pane = row.locator('.notebook-terminal-cell:visible');
      const prompts={ipython:'In [',sqlite:'sqlite>',python:'>>>',node:'Welcome to Node.js',irb:'irb(',mysql:'mysql>',rust:'>>',go:'>'};
      const prompt=prompts[await picker.inputValue()];
      if(prompt) await pane.locator('.xterm-rows').filter({hasText:prompt}).waitFor({timeout:15000});
      await pane.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(command); await page.keyboard.press('Enter');
      await page.waitForFunction(({pane, output}) => {
        const lines = document.querySelector(pane)?.querySelectorAll('.xterm-rows > div') ?? [];
        return [...lines].some(line => [output].flat().includes(line.textContent.trim().replace(/\s+/g,' ')));
      },{pane:'article[data-entry-kind=terminal] .notebook-terminal-cell:not([hidden])', output},{timeout:15000}).catch(async error=>{throw new Error('Waiting for '+output+' in '+await picker.inputValue()+': '+await pane.locator('.xterm-rows').innerText(),{cause:error});});
    };
    await page.evaluate(() => {
      window.observations = [];
      for (const room of window.rooms) room.localParticipant.performRpc = async request => {window.observations.push(JSON.parse(request.payload)); return 'ok';};
    });
    await enter("export CELL_NUMBER=39; echo $((CELL_NUMBER+3))",'42');
    // Instructor follows the terminal screen: the commands typed and what came back.
    await page.waitForFunction(() => window.observations.some(o => o.notebook?.cells.some(cell =>
      cell.kind === 'terminal' && cell.language === 'bash' && cell.text.includes('CELL_NUMBER+3') && /^42$/m.test(cell.text))),null,{timeout:10000});
    await picker.selectOption('zsh');
    await enter('print -r -- $((4*13))','52');
    await picker.selectOption('bash');
    await enter('echo $((CELL_NUMBER+4))','43');
    await enter("sh -c 'echo started; exec sleep 20'", 'started');
    await page.keyboard.press('Control+c');
    await row.locator('.notebook-terminal-cell:visible .xterm-rows').filter({hasText:'^C'}).waitFor();
    await enter('echo $((CELL_NUMBER+5))','44');
    // `exit` after a typo returns 127; that is the learner ending the shell, not a missing program.
    await enter('nosuchcmd_xyz','bash: nosuchcmd_xyz: command not found');
    await page.keyboard.type('exit'); await page.keyboard.press('Enter');
    await row.getByText('Bash session closed.').waitFor();
    assert.equal(await row.getByText('Bash is unavailable in this course runtime.').count(),0);
    await picker.selectOption('ipython');
    await enter('print(sum([20, 35]))','55');
    if(process.env.DHIMANTAI_TERMINAL_TYPES_SCREENSHOT) await row.screenshot({path:process.env.DHIMANTAI_TERMINAL_TYPES_SCREENSHOT});
    await picker.selectOption('sqlite');
    await enter('select 77;', ['77','(77,)']);
    // Only the current program and the last one stay running; older REPLs and shells were ended.
    assert.equal(await row.locator('.notebook-terminal-cell').count(),2);
    for (let wait = 0; [...clients.keys()].filter(key => key.startsWith('python:')).length > 2 && wait < 50; wait++)
      await new Promise(resolve => setTimeout(resolve,200));
    assert.deepEqual([...clients.keys()].filter(key => key.startsWith('python:')).map(key => key.split(':').at(-1)).sort(),['ipython','sqlite']);
    if (fixtureContainer) {
      await picker.selectOption('rust');
      await enter('let values: Vec<i32> = vec![4, 8, 14]; values.iter().sum::<i32>()','26');
      await picker.selectOption('go');
      await enter('println(6 * 17)','102');
      await picker.selectOption('irb');
      await enter('puts 6 * 13','78');
      await picker.selectOption('mysql');
      await enter('select 77 as answer;', '| 77 |');
    }
    await picker.selectOption('python'); await enter('print(16 * 3)','48');
    await picker.selectOption('node'); await enter('7 * 9','63');
    await picker.selectOption('oracle');
    await row.getByText('Oracle is unavailable in this course runtime.').waitFor();
    await picker.selectOption('db2');
    await row.getByText('IBM Db2 is unavailable in this course runtime.').waitFor();
    await picker.selectOption('ipython');
    await page.locator('#save-notebook').evaluate(button=>button.click());
    const saved = await page.evaluate(()=>window.posts.filter(m=>m.type==='exportNotebook').at(-1).notebook);
    assert.equal(saved.cells.find(cell=>cell.kind==='terminal').packet.language,'ipython');
    await page.evaluate(notebook=>window.fixturePost({type:'restoreNotebook',documentKey:'restored',notebook}),saved);
    assert.equal(await picker.inputValue(),'ipython');
    await page.evaluate(()=>window.fixturePost({type:'restoreNotebook',documentKey:'python-run',notebook:{version:1,title:'Python',cells:[],drafts:[]}}));
    // The same terminal surface also supports programs that consume stdin one line at a time.
    await page.evaluate(() => window.publish('Read a name.\n\n```python\nname = input("Name? ")\nprint("Hello", name)\n```'));
    const python = page.locator('.practice-code-editor').last();
    await python.locator('[data-action=run]').click();
    await expectScreen('Name?');
    await page.keyboard.type('Ashx');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await python.locator('.practice-output').filter({hasText:'Hello Asha'}).waitFor();
    assert.equal(messages.at(-1).exit_code, 0);
    assert.deepEqual(errors, []);
    console.log('Passed terminal type selection, shell state, interactive queries and REPLs, keyboard editing, interrupts, EOF, and notebook restore.');
  } finally { await Promise.all([...new Set([cells,...clients.values()])].map(client=>client.close())); await close(); }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
