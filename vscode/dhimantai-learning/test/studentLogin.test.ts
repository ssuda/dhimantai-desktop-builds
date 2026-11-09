import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkStudentIdentifier, isNetworkError, legacyStudentEmail, studentEmail } from '../src/studentLogin';

test('student email matches the app: lowercase, letters and digits, underscore format', () => {
  assert.equal(studentEmail('1234', '2024A001'), '2024a001_1234@vidyai.in');
  assert.equal(studentEmail(' KTS-001 ', ' 2024/A-001 '), '2024a001_kts001@vidyai.in');
  assert.equal(studentEmail('', '2024A001'), undefined);
  assert.equal(studentEmail('***', '2024A001'), undefined);
});

test('legacy email keeps punctuation, lowercased, dot format', () => {
  assert.equal(legacyStudentEmail(' KTS-001 ', ' 2024/A-001 '), '2024/a-001.kts-001@vidyai.in');
});

test('identifier checks accept any letter or digit, like the app', () => {
  assert.equal(checkStudentIdentifier('A-1', 'roll number'), undefined);
  assert.match(checkStudentIdentifier('  ', 'roll number')!, /Enter your roll number/);
  assert.match(checkStudentIdentifier('--', 'institute code')!, /valid institute code/);
});

test('network failures do not fall through to the legacy attempt', () => {
  assert.ok(isNetworkError('Could not reach dhimantAI. Check your connection'));
  assert.ok(isNetworkError('fetch failed'));
  assert.ok(!isNetworkError('Invalid login credentials'));
});
