import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ACCESS_ENDED, accessErrorMessage } from '../src/api';
import { CATALOG_PROJECTS, PROJECT_COURSES, projectAccessEnded } from '../src/catalogProjects';

test('projects that belong to an expired course are closed until it is bought again', () => {
  const expired = [{id: 'engineering-code-reading', expired: true}], active = [{id: 'engineering-code-reading', expired: false}];
  assert.equal(projectAccessEnded('shelf-reading', expired), true);
  assert.equal(projectAccessEnded('rich-reading', expired), true);
  assert.equal(projectAccessEnded('shelf-reading', active), false);
  assert.equal(projectAccessEnded('shelf-reading'), false, 'an offline catalog keeps bundled projects available');
  assert.equal(projectAccessEnded('course-agent', expired), false);
  for (const id of Object.keys(PROJECT_COURSES)) assert.ok(CATALOG_PROJECTS.some(project => project.id === id));
});

test('payment and access-period refusals read as Access ended · Buy again', () => {
  assert.equal(accessErrorMessage(402, '/notebook-coach/labs', 'Payment Required'), ACCESS_ENDED);
  assert.equal(accessErrorMessage(403, '/anything', 'Forbidden', 'access_expired'), ACCESS_ENDED);
  assert.match(accessErrorMessage(403, '/course-project-handoffs',
    'Join an available Python course before using project submissions or managed live runs.')!, /Access ended · Buy again/);
  assert.match(accessErrorMessage(403, '/notebook-coach/project', 'Project help needs active Python course access. Join a Python course, '
    + 'or if your access period ended: Open Pricing & Purchases in VS Code to buy the course, a bundle, or another access period.')!, /Join a Python course.*Access ended · Buy again/);
  assert.equal(accessErrorMessage(403, '/notebook-coach/exercises/x/questions', 'Your access to this course ended. Buy it again from the Course Catalog to continue.'), ACCESS_ENDED);
  assert.equal(accessErrorMessage(403, '/course-project-handoffs', 'Your learner profile is unavailable.'), undefined);
  assert.equal(accessErrorMessage(403, '/learning-room', 'An approved student account is required.'), undefined);
  assert.equal(accessErrorMessage(500, '/course-project-handoffs', 'Python course'), undefined);
});
