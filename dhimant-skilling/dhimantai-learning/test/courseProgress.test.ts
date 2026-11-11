import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ChapterCoverage, courseCoverage, coverageLabel, topicCoverageHtml } from '../src/courseProgress';

test('course counts separate taught, remaining, revised and unavailable chapters', () => {
  const chapter = (status: ChapterCoverage['status']) => ({progress:{status, covered:0, total:0, topics:[]}});
  assert.equal(courseCoverage([chapter('covered'), chapter('in_progress'), chapter('not_started'), chapter('content_changed'), {}]),
    '1/5 chapters covered · 1 in progress · 1 not started · 1 to revisit · 1 unavailable');
  assert.equal(courseCoverage([{}]), 'Progress unavailable');
  assert.equal(coverageLabel(), 'Progress unavailable');
});

test('only taught titles are struck through, review stays visible and topic text is escaped', () => {
  const progress: ChapterCoverage = {status:'in_progress', covered:1, total:3, topics:[
    {id:'a', title:'<script>Indexing</script>', status:'covered', needs_review:true},
    {id:'b', title:'Slicing', status:'in_progress'}, {id:'c', title:'Loops', status:'not_started'},
  ]};
  const dom = new JSDOM(topicCoverageHtml(progress));
  try {
    assert.equal(dom.window.document.querySelectorAll('s').length, 1);
    assert.equal(dom.window.document.querySelector('s')!.textContent, '<script>Indexing</script>');
    assert.equal(dom.window.document.querySelectorAll('script').length, 0);
    assert.match(dom.window.document.body.textContent!, /Covered · Needs review/);
    assert.match(dom.window.document.body.textContent!, /Slicing In progress/);
    assert.match(dom.window.document.body.textContent!, /Loops Not started/);
  } finally { dom.window.close(); }
});
