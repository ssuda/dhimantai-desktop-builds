import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CourseEngine } from '../src/courseEngine';
import { gradeLocally } from '../src/notebookSubmission';
import type { GradingSuite } from '../src/api';

/**
 * Submit for grading for a Java Practice question, through the real path: gradeLocally -> CourseEngine.tests ->
 * `podman exec <container> node /opt/dhimantai/runner.cjs`, which compiles Main.java and runs each stdio case.
 * Opt-in: set DHIMANTAI_JAVA_COURSE_CONTAINER to a running Java course container with /course mounted
 * (its runner.cjs should be this build's media/course/runner.cjs).
 */
const container = process.env.DHIMANTAI_JAVA_COURSE_CONTAINER;

const reference = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt(), hot = 0;
        for (int i = 0; i < n; i++) if (in.nextInt() >= 40) hot++;
        System.out.println("HOT " + hot);
    }
}
`;

const suite: GradingSuite = {
  suite_version: 1, question_id: 'java-hot-days',
  tests: [
    { id: 'case-01', visibility: 'public', kind: 'stdio', stdin: '3 38 41 45\n', expected: 'HOT 2\n', category: 'other' },
    { id: 'case-02', visibility: 'hidden', kind: 'stdio', stdin: '2 40 40\n', expected: 'HOT 2\n', category: 'off-by-one' },
    { id: 'case-03', visibility: 'hidden', kind: 'stdio', stdin: '0\n', expected: 'HOT 0\n', category: 'empty input' },
    { id: 'case-04', visibility: 'hidden', kind: 'stdio', stdin: '1 39\n', expected: 'HOT 0\n', category: 'edge case' },
    { id: 'case-05', visibility: 'hidden', kind: 'stdio', stdin: '4 100 1000 40 39\n', expected: 'HOT 3\n', category: 'large input' },
  ],
} as unknown as GradingSuite;

test('Java Practice grading compiles and runs every stdio case in the course container', { skip: !container }, async () => {
  const engine = new CourseEngine('podman', container!, mkdtempSync(join(tmpdir(), 'java-grading-')));
  const grade = (source: string) => gradeLocally(async () => structuredClone(suite),
    cases => engine.tests('java', { source, stdin: '', argv: [], files: [] }, cases), suite.question_id);

  const right = await grade(reference);
  assert.deepEqual([right.passed, right.total, right.all_passed], [5, 5, true]);

  const offByOne = await grade(reference.replace('>= 40', '> 40'));
  assert.equal(offByOne.all_passed, false);
  assert.deepEqual(offByOne.cases.filter(c => c.verdict !== 'passed').map(c => [c.id, c.verdict, c.category]),
    [['case-02', 'wrong_answer', 'off-by-one'], ['case-05', 'wrong_answer', 'large input']]);

  const broken = await grade('public class Main { void broken( }\n');
  assert.ok(broken.cases.every(c => c.verdict === 'compile_error'));
});
