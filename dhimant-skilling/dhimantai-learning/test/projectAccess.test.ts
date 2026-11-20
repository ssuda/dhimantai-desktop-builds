import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ACCESS_ENDED, accessErrorMessage } from '../src/api';
import { CATALOG_PROJECTS, PROJECT_COURSES, projectAccessEnded, projectCourseChoices } from '../src/catalogProjects';

test('projects that belong to an expired course are closed until it is bought again', () => {
  const expired = [{id: 'engineering-code-reading', expired: true}], active = [{id: 'engineering-code-reading', expired: false}];
  assert.equal(projectAccessEnded('shelf-reading', expired, []), true);
  assert.equal(projectAccessEnded('rich-reading', expired, []), true);
  assert.equal(projectAccessEnded('rich-reading', expired), false, 'retry the access lookup if the practice catalog failed to load');
  assert.equal(projectAccessEnded('shelf-reading', active), false);
  assert.equal(projectAccessEnded('shelf-reading'), false, 'an offline catalog keeps bundled projects available');
  assert.equal(projectAccessEnded('course-agent', expired), false);
  for (const project of CATALOG_PROJECTS) assert.ok(PROJECT_COURSES[project.id]);
});

test('project choices include the companion, active free chapters and purchases, and exclude unavailable courses', () => {
  const open = {id: 'intro', name: 'Introduction'}, locked = {...open, locked: true};
  const courses = [
    {name: 'Algorithms with Python', project_coach: {course_id: 'algorithms-python'}, chapters: [open, locked]},
    {name: 'Build AI Agents with Python', project_coach: {course_id: 'build-ai-agents'}, chapters: [open]},
    {name: 'Read an Unfamiliar Codebase', project_coach: {course_id: 'engineering-code-reading'}, chapters: [open]},
    {name: 'Data Structures with Python', project_coach: null, chapters: [{...open, expired: true}]},
    {name: 'Java', project_coach: null, chapters: [open]},
  ];
  const choices = projectCourseChoices('shelf-reading', courses);
  assert.deepEqual(choices.map(c => c.label), [courses[2].name, courses[0].name, courses[1].name]);
  assert.match(choices[0].description!, /Companion/);
  assert.match(choices[1].detail, /active chapter/);
  assert.equal(projectAccessEnded('shelf-reading', [{id:'engineering-code-reading', expired:true}], [courses[1]]), false);
  assert.deepEqual(projectCourseChoices('shelf-reading', [
    {name: 'Python', chapters: [open]}, {name: 'Build AI Agents with Python', chapters: [open]},
  ]).map(c => c.label), ['Python']);
});

test('only confirmed project expiry is presented as a renewal', () => {
  assert.equal(accessErrorMessage(402, '/notebook-coach/labs', 'Payment Required'), ACCESS_ENDED);
  assert.equal(accessErrorMessage(403, '/anything', 'Forbidden', 'access_expired'), ACCESS_ENDED);
  assert.match(accessErrorMessage(403, '/course-project-handoffs',
    'Join an available Python course before using project submissions or managed live runs.')!, /active Python course/);
  assert.match(accessErrorMessage(403, '/notebook-coach/project', 'Project help needs active Python course access. Join a Python course, '
    + 'or if your access period ended: Open Pricing & Purchases in VS Code to buy the course, a bundle, or another access period.')!, /active Python course/);
  assert.doesNotMatch(accessErrorMessage(402, '/notebook-coach/project?course=Python', 'Payment required')!, /ended|again/i);
  assert.equal(accessErrorMessage(403, '/notebook-coach/exercises/x/questions', 'Your access to this course ended. Buy it again from the Course Catalog to continue.'), ACCESS_ENDED);
  assert.equal(accessErrorMessage(403, '/course-project-handoffs', 'Your learner profile is unavailable.'), undefined);
  assert.equal(accessErrorMessage(403, '/learning-room', 'An approved student account is required.'), undefined);
  assert.equal(accessErrorMessage(500, '/course-project-handoffs', 'Python course'), undefined);
});
