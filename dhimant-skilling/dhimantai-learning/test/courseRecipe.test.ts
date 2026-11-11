import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { courseDockerfile, courseRecipe, Recipe, recipeLanguage } from '../src/courseRecipe';

const media = join(__dirname, '../../media/course');
const profiles: Record<string, Recipe> = JSON.parse(readFileSync(join(media, 'profiles.json'), 'utf8'));
const template = readFileSync(join(media, 'Dockerfile'), 'utf8');
const languageScript = readFileSync(join(media, 'language.sh'), 'utf8');

test('AI at Work installs PostgreSQL for Ask your data without making its notebook SQL', () => {
  assert.equal(recipeLanguage(profiles, 'AI at Work'), undefined);
  const recipe = courseRecipe(profiles, ' AI at Work ');
  assert.equal(recipe.language, 'python');
  assert.deepEqual(recipe.services, ['postgres']);
  const dockerfile = courseDockerfile(template, recipe);
  assert.match(dockerfile, /for item in python postgres; do \/usr\/local\/sbin\/dhimantai-language "\$item" \|\| exit 1; done/);
  assert.doesNotMatch(dockerfile, /COURSE_INSTALLS|COURSE_LANGUAGE/);
  // language.sh installs PostgreSQL 17 for the service exactly as it does for the SQL courses.
  assert.match(languageScript, /^\s*sql\|pglab\|postgres\)/m);
});

test('the PostgreSQL courses keep their notebook language and image', () => {
  assert.equal(recipeLanguage(profiles, 'Databases with PostgreSQL'), 'sql');
  assert.equal(recipeLanguage(profiles, 'PostgreSQL Administration (DBA)'), 'pglab');
  assert.equal(courseRecipe(profiles, 'PostgreSQL Administration (DBA)').scenarios, 'postgresql-dba');
  for (const [course, language] of [['Databases with PostgreSQL', 'sql'], ['PostgreSQL Administration (DBA)', 'pglab']]) {
    const recipe = courseRecipe(profiles, course);
    assert.deepEqual([recipe.language, recipe.services], [language, []]);
    assert.match(courseDockerfile(template, recipe), new RegExp(`for item in ${language}; do`));
  }
});

test('no profile sets a service that language.sh cannot install, and unknown services are refused', () => {
  for (const course of Object.keys(profiles)) assert.doesNotThrow(() => courseRecipe(profiles, course));
  assert.throws(() => courseRecipe({x: {services: ['redis; rm -rf /']}}, 'x'), /Unsupported course service/);
  assert.throws(() => courseRecipe({x: {scenarios: '../other-course'}}, 'x'), /Invalid course scenario/);
  assert.throws(() => courseDockerfile(template, {language: 'sql; true', services: []}), /Unsupported course language/);
  assert.equal(courseRecipe({}, 'golang').language, 'python');
  assert.equal(courseRecipe({}, 'go').language, 'go');
});
