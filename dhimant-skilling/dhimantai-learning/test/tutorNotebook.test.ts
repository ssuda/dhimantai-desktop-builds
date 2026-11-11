import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyNotebook, exportNotebook, importNotebook, serializeNotebook, NOTEBOOK_FILE_LIMIT, readNotebook } from '../src/tutorNotebook';
import { NotebookConflictError, TutorNotebookStore } from '../src/tutorNotebookStore';
import { codeLanguages } from '../src/roomCode';
import { TutorPython } from '../src/tutorPython';
import { practiceDocument, savedPractice } from '../src/practiceNotebook';

test('notebook import diagnoses corrupt, unsupported and oversized files and round-trips saved work', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const book = emptyNotebook(); book.title = 'నా నోట్'; book.cells.push({id:'note-1',kind:'note',text:'Private notes'});
  assert.deepEqual(importNotebook(new TextEncoder().encode(serializeNotebook(book))), book);
  assert.throws(() => importNotebook(new TextEncoder().encode('{broken')), /corrupted.*JSON/);
  assert.throws(() => importNotebook(new Uint8Array([255])), /UTF-8/);
  assert.throws(() => importNotebook(new Uint8Array(NOTEBOOK_FILE_LIMIT + 1)), /12 MiB/);
  assert.throws(() => importNotebook(encode({nbformat:3,cells:[]})), /Jupyter 4/);
  assert.throws(() => importNotebook(encode({nbformat:4,cells:[],metadata:{dhimantai_tutor_notebook:{...book,version:2}}})), /version is not supported/);
  assert.throws(() => importNotebook(encode({nbformat:4,cells:[],metadata:{dhimantai_tutor_notebook:null}})), /missing or corrupted/);
});

test('standard Jupyter imports text and edited source without accepting output as current execution', () => {
  const file = {nbformat:4,metadata:{language_info:{name:'python'}},cells:[
    {cell_type:'markdown',source:['# My exercise\n','Use `value`.']},
    {cell_type:'code',source:['value = 41\n','print(value + 1)'],execution_count:9,outputs:[{text:'fake success'}],metadata:{dhimantai:{assisted:true}}},
    {cell_type:'code',source:'console.log(42)',metadata:{vscode:{languageId:'javascript'}}},
  ]};
  const book = importNotebook(new TextEncoder().encode(JSON.stringify(file)), 'Jupyter practice');
  assert.equal(book.title,'Jupyter practice'); assert.equal(book.cells[0].text,'# My exercise\nUse `value`.');
  assert.equal(book.drafts[0].source,'value = 41\nprint(value + 1)'); assert.equal(book.drafts[0].helped,true);
  assert.equal(book.drafts[1].language,'javascript'); assert.equal(JSON.stringify(book).includes('fake success'),false);
  assert.deepEqual(importNotebook(new TextEncoder().encode(serializeNotebook(book))),book);
  assert.throws(() => importNotebook(new TextEncoder().encode(JSON.stringify({...file,cells:[{cell_type:'code',source:'x'.repeat(12001)}]}))), /Code cell 1 exceeds/);
  assert.throws(() => importNotebook(new TextEncoder().encode(JSON.stringify({...file,metadata:{language_info:{name:'julia'}}}))), /unsupported language/);
});

test('local notebook restores edits for every language without inventing execution or assessment evidence', () => {
  const book = emptyNotebook();
  book.textDraft = 'My unsent question\nwith a second line.';
  for (const [index, language] of Object.keys(codeLanguages).entries()) {
    book.cells.push({id:'cell-' + index, kind:'code', text:'', packet:{language}});
    book.drafts.push({key:'cell-' + index + ':0', snippet:'code-' + index, language, source:'student work in ' + language,
      stdin:'input', prediction:'prediction', explanation:'my reasoning', helped:true});
  }
  const restored = readNotebook(JSON.parse(JSON.stringify(book)));
  assert.deepEqual(restored, book);
  const exported = exportNotebook(restored);
  const cells = exported.cells as any[];
  assert.equal(cells.length, 8);
  assert.equal(cells.at(-1).source,book.textDraft);
  assert.equal(cells.at(-1).metadata.dhimantai.kind,'note');
  assert.deepEqual(cells.slice(0,7).map(cell => cell.metadata.vscode.languageId), Object.keys(codeLanguages));
  for (const cell of cells.slice(0,7)) {
    assert.deepEqual(cell.outputs, []); assert.equal(cell.execution_count, null);
    assert.equal(cell.metadata.dhimantai.assisted, true);
  }
  assert.throws(() => readNotebook({...book, cells:[book.cells[0], book.cells[0]]}));
  assert.throws(() => readNotebook({...book, drafts:[{...book.drafts[0], language:'shell'}]}));
});

test('autosave writes the newest document atomically and isolates accounts and environments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tutor-notebook-test-'));
  try {
    const alice = new TutorNotebookStore(directory, 'staging', 'alice');
    const bob = new TutorNotebookStore(directory, 'staging', 'bob');
    const production = new TutorNotebookStore(directory, 'production', 'alice');
    const book = emptyNotebook(); book.cells.push({id:'note-1',kind:'note',text:'First draft'});
    const first = alice.save(book);
    book.cells[0].text = 'My latest explanation';
    const newest = alice.save(book);
    const reopened = new TutorNotebookStore(directory, 'staging', 'alice');
    assert.equal((await reopened.load()).cells[0].text, 'My latest explanation');
    await Promise.all([first, newest]);
    assert.equal((await alice.load()).cells[0].text, 'My latest explanation');
    assert.deepEqual(await bob.load(), emptyNotebook());
    assert.deepEqual(await production.load(), emptyNotebook());
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('Python notebook keeps executed definitions, handles errors/input, and clears state on restart', async () => {
  const kernel = new TutorPython(() => ({}), undefined, 2500);
  try {
    assert.equal((await kernel.run('value = 40', '')).exit_code, 0);
    assert.equal((await kernel.run('value + 2', '')).stdout, '42\n');
    assert.equal((await kernel.run('print(input().upper())', 'hello\n')).stdout, 'HELLO\n');
    assert.match((await kernel.run('1 / 0', '')).stderr, /ZeroDivisionError/);
    assert.equal((await kernel.run('value', '')).stdout, '40\n');
    kernel.restart();
    assert.match((await kernel.run('value', '')).stderr, /NameError/);
    const timeout = await kernel.run('while True: pass', '');
    assert.equal(timeout.status, 'timeout');
    assert.equal((await kernel.run('print("recovered")', '')).stdout, 'recovered\n');
  } finally { kernel.restart(); }
});

test('history recovers generated notebooks and conversations without exposing another account or environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'practice-history-test-'));
  try {
    const id = 'generated-' + 'a'.repeat(24);
    const book = practiceDocument({id, title:'Swap', language:'python', question:'Swap and subtract.', starter:'',
      assistance:true, account:'alice', path:'/notebook-coach/tutor', tests:[]});
    book.cells.push({id:'reply-1',kind:'board',text:'After swapping, subtract the new values.'});
    book.drafts.push({key:'practice-question:0',snippet:'code-1',language:'python',source:'a, b = b, a',
      stdin:'',prediction:'-4',explanation:'',helped:true});
    await new TutorNotebookStore(directory, 'staging', 'alice\0practice:' + id).save(book);
    await new TutorNotebookStore(directory, 'production', 'alice\0practice:' + id).save({...book,title:'Production only'});
    await new TutorNotebookStore(directory, 'staging', 'bob\0practice:' + id).save({...book,title:'Bob only'});
    await writeFile(join(directory, 'f'.repeat(64) + '.json'), '{invalid');
    const history = await TutorNotebookStore.practiceHistory(directory, 'staging', 'alice');
    assert.equal(history.length, 1);
    assert.equal(savedPractice(history[0].notebook, 'alice')!.title, 'Swap');
    assert.equal(history[0].notebook.drafts[0].source, 'a, b = b, a');
    assert.equal(history[0].notebook.cells.at(-1)!.text, 'After swapping, subtract the new values.');
    assert.deepEqual(await TutorNotebookStore.practiceHistory(directory, 'staging', 'charlie'), []);
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('two windows never silently overwrite each other: a stale save is refused until the learner reloads or keeps it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tutor-notebook-test-'));
  try {
    const first = new TutorNotebookStore(directory, 'staging', 'alice\0tutor:lesson');
    const second = new TutorNotebookStore(directory, 'staging', 'alice\0tutor:lesson');
    assert.deepEqual(await first.load(), emptyNotebook());
    assert.deepEqual(await second.load(), emptyNotebook());
    const mine = emptyNotebook(); mine.cells.push({id:'note-1', kind:'note', text:'Window one'});
    const theirs = emptyNotebook(); theirs.cells.push({id:'note-1', kind:'note', text:'Window two'});
    await first.save(mine);
    await first.save({...mine, title:'Still window one'});
    await assert.rejects(second.save(theirs), NotebookConflictError);
    assert.equal((await new TutorNotebookStore(directory, 'staging', 'alice\0tutor:lesson').load()).cells[0].text, 'Window one');
    // Reloading the newer copy makes the next save safe again.
    assert.equal((await second.load()).cells[0].text, 'Window one');
    await second.save(theirs);
    await assert.rejects(first.save(mine), NotebookConflictError);
    // An explicit "keep this version" replaces the other window's copy.
    await first.save(mine, true);
    assert.equal((await second.load()).cells[0].text, 'Window one');
    const fresh = new TutorNotebookStore(directory, 'staging', 'alice\0tutor:lesson');
    await assert.rejects(fresh.save(theirs), NotebookConflictError, 'a store that never read an existing file cannot overwrite it');
  } finally { await rm(directory, {recursive:true, force:true}); }
});
