import {AppForm} from './types';
import {ReplayResult, ReplayTask} from './replay';

/** One authoring pass, independent of VS Code UI so it can be tested with fakes. */
export interface AuthoringSteps {
  discover(forms: string[]): Promise<AppForm[]>;
  ask(questions: string[]): Promise<{question: string; answer: string}[] | undefined>;
  interview(goal: string, forms: AppForm[]): Promise<string[]>;
  draft(goal: string, forms: AppForm[], answers: {question: string; answer: string}[], revise?: {course: unknown; problems: string[]}): Promise<{title: string; lessons: ReplayTask[]}>;
  replay(lessons: ReplayTask[]): Promise<ReplayResult[]>;
  report(message: string): void;
}

/**
 * Discover → interview → draft → replay in the real application → revise from what failed (up to twice).
 * Returns the course only when every task was completed in the application and every decision matters.
 */
export async function authorCourse(goal: string, formNames: string[], steps: AuthoringSteps) {
  const forms = await steps.discover(formNames);
  steps.report(`Discovered ${forms.length} forms: ${forms.map(f => `${f.form} (${f.fields.length} fields)`).join(', ')}.`);
  const answers = await steps.ask(await steps.interview(goal, forms));
  if (!answers) return undefined;
  let course = await steps.draft(goal, forms, answers);
  for (let round = 0; ; round++) {
    steps.report(`Replaying “${course.title}” (${course.lessons.length} tasks) in the application…`);
    const results = await steps.replay(course.lessons);
    for (const r of results) steps.report(`  ${r.ok ? (r.discriminates ? 'passed' : 'passed, but a wrong decision would also pass') : 'failed'}: ${r.task}${r.reason ? ' — ' + r.reason : ''}`);
    const problems = results.flatMap(r => !r.ok ? [`Task ${r.task}: replay failed: ${r.reason}`]
      : r.discriminates === false ? [`Task ${r.task}: a wrong value in a decide=true field still passes; check that field in expected.`] : []);
    if (!problems.length) return {course, results};
    if (round >= 2) throw new Error('The draft still fails in the application after two revisions: ' + problems.slice(0, 3).join(' '));
    steps.report('Revising the draft from what failed in the application…');
    course = await steps.draft(goal, forms, answers, {course, problems});
  }
}
