import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readingCursor, readingUrl, studyAction} from '../src/studyContent';

test('Study only accepts bounded EPUB cursors and safe external reading links', () => {
  assert.equal(readingCursor('epubcfi(/6/2!/4/8/1:0)'), 'epubcfi(/6/2!/4/8/1:0)');
  for(const value of ['javascript:alert(1)','epubcfi(<script>)','epubcfi('+'1'.repeat(1300)+')',null]) assert.equal(readingCursor(value),undefined);
  for(const url of ['command:run','file:///tmp/private','https://user:secret@example.org/','javascript:alert(1)']) assert.equal(readingUrl(url),false);
  assert.equal(readingUrl('https://thinking-forth.sourceforge.net/'),true);
  assert.equal(studyAction('grade'),false); assert.equal(studyAction('summary'),true);
});

test('the packaged reader shares Flutter assets and the verified seven-course bundle', () => {
  const root=resolve(__dirname,'../../../..');
  const media=resolve(__dirname,'../../media/study');
  const bundle=JSON.parse(readFileSync(resolve(media,'book_companions.json'),'utf8'));
  assert.equal(bundle.courses.length,7);
  const ids=new Set<string>();
  for(const course of bundle.courses) for(const chapter of course.chapters) {
    assert.equal(ids.has(chapter.id),false); ids.add(chapter.id);
    assert.equal(chapter.revision,createHash('sha256').update(chapter.markdown).digest('hex'));
    assert.ok(chapter.markdown.includes('## Transfer task'));
    assert.ok(course.reading.every((link:{url:string})=>readingUrl(link.url)));
  }
  assert.equal(ids.size,21);
  for(const file of ['epub.min.js','jszip.min.js','reader_bridge.js']) assert.deepEqual(readFileSync(resolve(media,file)),readFileSync(resolve(root,'assets/epub_reader',file)));
});
