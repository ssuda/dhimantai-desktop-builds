import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { courseDockerfile, courseDockerfileServices, courseRecipe, exerciseLanguages, courseRequirements, Recipe, recipeLanguage, programmingRecipe } from '../src/courseRecipe';
import {cellLanguages} from '../src/roomCode';

const media = join(__dirname, '../../media/course');
const profiles: Record<string, Recipe> = JSON.parse(readFileSync(join(__dirname,'../../../../content/courses/runtime-profiles.json'), 'utf8'));
const template = readFileSync(join(media, 'Dockerfile'), 'utf8');
const languageScript = readFileSync(join(media, 'language.sh'), 'utf8');

test('the shared programming image includes every language offered by the notebook editor', () => {
  const recipe = programmingRecipe();
  const dockerfile = courseDockerfile(template, recipe);
  const installs = dockerfile.match(/for item in (python [^;]+);/)![1].split(' ');
  assert.deepEqual(new Set(installs), new Set(Object.keys(cellLanguages)));
  assert.equal(installs.length, new Set(installs).size);
  assert.equal(recipe.torch, undefined, 'specialized course packages stay in their course images');
  assert.deepEqual(recipe.requirements, profiles['data science with python'].requirements);
  assert.deepEqual(recipe.imports, ['numpy', 'pandas', 'matplotlib', 'sklearn']);
  for(const course of ['machine learning with scikit-learn','machine learning']) {
    assert.deepEqual(profiles[course].requirements,recipe.requirements);
    for(const name of recipe.imports!)assert.ok(profiles[course].imports?.includes(name));
  }
  assert.throws(() => courseDockerfile(template, {...recipe, languages:['java; true']}), /Unsupported course language/);
});

test('speech-to-text setup installs and verifies the libraries used by Instructor run records', () => {
  const recipe = courseRecipe(profiles, 'Developing Speech-to-Text Models');
  assert.ok(recipe.requirements?.includes('transformers==4.57.6'));
  for (const name of ['torch', 'numpy', 'transformers']) assert.ok(recipe.imports?.includes(name));
  assert.match(courseDockerfile(template, recipe), /torch==2\.9\.1/);
  assert.equal(courseRequirements(undefined, recipe), 'numpy==2.1.3\ntransformers==4.57.6\n');
});

test('SDK and audio services are included in images without changing the course notebook language', () => {
  for (const [title, service] of [
    ['LLM APIs, Tool Calling & MCP', 'javascript'], ['Retrieval, Context & Memory Engineering', 'javascript'],
    ['Reliable Agent Workflows', 'javascript'], ['Agent Evaluation & Production Engineering', 'javascript'],
    ['Developing Speech-to-Text Models', 'audio'], ['Developing TTS Models with IndicSpeak', 'audio']]) {
    const recipe = courseRecipe(profiles, title);
    assert.equal(recipe.language, 'python');
    assert.ok(recipe.services.includes(service));
    assert.match(courseDockerfile(template, recipe), new RegExp('for item in python ' + service + ';'));
  }
  const original = courseDockerfile(template, {language:'python', services:[]}) + '\n# learner customization\n';
  const updated = courseDockerfileServices(original, ['javascript', 'audio']);
  assert.equal(updated, original.replace('for item in python;', 'for item in python javascript audio;'));
  assert.equal(courseDockerfileServices(updated, ['javascript', 'audio']), updated);
  assert.equal(courseDockerfileServices('FROM custom\n# no generated loop\n', ['audio']), 'FROM custom\n# no generated loop\n');
  assert.throws(() => courseDockerfileServices(original, ['audio; true']), /Unsupported course service/);
});

test('rebuilding an existing course adds missing dependencies and preserves learner requirements', () => {
  const recipe = courseRecipe(profiles, 'Developing Speech-to-Text Models');
  for (const newline of ['\n', '\r\n']) {
    const before = ['# My course dependencies', 'numpy==2.1.3', 'requests==2.32.3', ''].join(newline);
    const after = courseRequirements(before, recipe);
    assert.equal(after, before + 'transformers==4.57.6' + newline);
    assert.equal(courseRequirements(after, recipe), after);
  }
  const custom = '# Keep these pins\nnumpy>=2\nTransformers[tokenizers]==4.57.5\n-r extra.txt';
  assert.equal(courseRequirements(custom, recipe), custom);
  assert.equal(courseRequirements('numpy==2.1.3', recipe), 'numpy==2.1.3\ntransformers==4.57.6\n');
  assert.equal(courseRequirements('Scikit_Learn==1.6.1\n', {requirements:['scikit-learn==1.6.1']}), 'Scikit_Learn==1.6.1\n');
});

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
  assert.deepEqual(courseRecipe(profiles, 'AI-Assisted PostgreSQL DBA'),
    courseRecipe(profiles, 'PostgreSQL Administration (DBA)'));
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

test('older Node-only workspace Dockerfiles gain matching npm while preserving learner edits',()=>{
 const old='FROM node:22 AS node_runtime\nFROM python:3.12\nCOPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node\n# learner edit\nRUN echo custom\n';
 const updated=courseDockerfileServices(old,[]);
 assert.ok(updated.includes('COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm'));
 assert.ok(updated.includes('npm-cli.js /usr/local/bin/npm'));
 assert.ok(updated.endsWith('# learner edit\nRUN echo custom\n'));
 assert.equal(courseDockerfileServices(updated,[]),updated);
});

test('Practice offers only the languages a course teaches, and every language for multi-language runtimes', () => {
  const service = ['python', 'rust', 'c', 'cpp', 'java', 'javascript', 'typescript', 'go', 'sql', 'pglab'].map(id => ({id, name: id}));
  const ids = (recipe: Recipe | undefined) => exerciseLanguages(service, recipe).map(l => l.id);
  assert.deepEqual(ids(courseRecipe(profiles, 'Build an LLM from Scratch')), ['python']);
  assert.deepEqual(ids(courseRecipe(profiles, 'C Programming')), ['c']);
  assert.deepEqual(ids(programmingRecipe()).sort(), service.map(l => l.id).sort(), 'the shared programming container teaches them all');
  assert.deepEqual(ids({language: 'bash'}), service.map(l => l.id), 'a shell course the generator cannot run keeps the full list');
  assert.deepEqual(ids(undefined), service.map(l => l.id), 'no course configuration keeps the full list');
});
