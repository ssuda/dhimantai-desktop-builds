import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ESSENTIAL_PATHS} from '../src/essentials';

test('catalog paths match the Engineering Essentials curriculum', () => {
  const source = readFileSync(join(__dirname, '../../../../content/courses/engineering-essentials/curriculum.py'), 'utf8');
  const block = source.slice(source.indexOf('PATHWAYS = {'));
  const paths = [...block.matchAll(/'[\w-]+': \[([^\]]*)\]/g)].map(m => [...m[1].matchAll(/'([\w-]+)'/g)].map(x => x[1]));
  assert.deepEqual(ESSENTIAL_PATHS.map(p => p.courses), paths);
});
