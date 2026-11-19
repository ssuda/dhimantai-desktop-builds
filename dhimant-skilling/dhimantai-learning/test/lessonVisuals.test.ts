import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {freshTeachingVisuals} from '../src/lessonVisuals';

test('visual replay filtering preserves executable code, inline literals and explicit revisits',()=>{
  const svg='<svg><text>Agent</text></svg>', image='![Agent](https://example.com/agent.png)';
  const code='```python\ntext = "'+image+'"\nsvg = "'+svg+'"\n```';
  const text=svg+'\n\n'+image+'\n\n'+code+'\n\n`'+image+'`\n\nA new idea.';
  const filtered=freshTeachingVisuals(text,[svg,image]);
  assert.ok(filtered.includes(code));assert.ok(filtered.includes('`'+image+'`'));
  assert.ok(filtered.endsWith('A new idea.'));
  assert.equal(freshTeachingVisuals(text,[text],true),text);
  assert.equal(freshTeachingVisuals(svg,[code]),svg,'code literals do not count as displayed figures');
  assert.equal(freshTeachingVisuals('![Another label](https://example.com/agent.png)',[image]),'');
  const xml='```xml\n<message>hello</message>\n```';
  assert.equal(freshTeachingVisuals(xml,[xml]),xml,'ordinary XML remains instructional code');
});

test('image identity follows the source across packet and Markdown representations',()=>{
  const source='https://example.com/figure(1).png?version=2&view=full';
  const packet=`![Figure \\[1\\]](<${source}>)`;
  assert.equal(freshTeachingVisuals(`![Another caption](${source} "Textbook")`,[packet]),'');
  assert.equal(freshTeachingVisuals(packet,[`![Original](${source})`]),'');
  assert.equal(freshTeachingVisuals('![Image](https://EXAMPLE.com:443/figure.png)', ['![Image](<https://example.com/figure.png>)']), '');
  const changed=`![Updated](${source.replace('version=2','version=3')})`;
  assert.equal(freshTeachingVisuals(changed,[packet]),changed,'meaningful source queries stay distinct');
  assert.equal(freshTeachingVisuals('![Other](https://other.example/figure(1).png)',[packet]),'![Other](https://other.example/figure(1).png)');
});

test('one requested repeat still removes duplicate copies within the response',()=>{
  const image='![Figure](https://example.com/figure.png)';
  const repeated=freshTeachingVisuals(image+'\n\n![New caption](<https://example.com/figure.png>)\n\nRead the arrows.',[image],true);
  assert.equal(repeated,image+'\n\n\n\nRead the arrows.');
});

test('raw and fenced SVGs share identity without changing different diagrams or code',()=>{
  const svg='<svg viewBox="0 0 100 50"><text x="10">Agent</text></svg>';
  for(const info of ['svg','xml','']) {
    const fenced='```'+info+'\n'+svg+'\n```';
    assert.equal(freshTeachingVisuals(fenced,[svg]),'');
    assert.equal(freshTeachingVisuals(svg,[fenced]),'');
  }
  const next=svg.replace('Agent','Tool');
  const xml='<?xml version="1.0"?>\n'+svg;
  assert.equal(freshTeachingVisuals(xml,[svg]),'');
  assert.equal(freshTeachingVisuals(svg,[xml]),'');
  assert.equal(freshTeachingVisuals(next,[svg]),next);
  const code='```python\nvalue = "'+svg+'"\n```';
  assert.equal(freshTeachingVisuals(code,[svg]),code);
});
