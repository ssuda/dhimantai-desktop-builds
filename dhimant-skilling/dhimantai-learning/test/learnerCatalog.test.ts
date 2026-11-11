import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { accessPeriod, CatalogCourse } from '../src/learnerCatalog';

const course = (patch: Partial<CatalogCourse>): CatalogCourse => ({id: 'python', title: 'Python', summary: '', level: '',
  prerequisites: '', can_join: true, enrolled: false, chapters: [], access_days: 60, ...patch});

test('access period shows the course duration before joining', () => {
  assert.equal(accessPeriod(course({})), '60 days of access');
});

test('access period shows the end date while access lasts', () => {
  assert.equal(accessPeriod(course({enrolled: true, access_until: '2027-11-08T10:00:00Z'})), 'Access until 8 Nov 2027');
});

test('expired paid courses ask to buy again; expired free courses only say they ended', () => {
  const ended = {enrolled: true, expired: true, access_until: '2026-01-05T10:00:00Z'};
  assert.equal(accessPeriod(course(ended)), 'Access ended 5 Jan 2026 · Buy again to continue');
  assert.equal(accessPeriod(course({...ended, is_free: true})), 'Access ended 5 Jan 2026');
});
