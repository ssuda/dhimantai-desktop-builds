import type { GeneratedExercise, PublicTest, Workspace } from './api';
import { codeLanguage } from './roomCode';
import { emptyNotebook, TutorNotebook } from './tutorNotebook';

export interface PracticeNotebook {
  id: string; language: string; question: string; starter: string; title: string;
  assistance: boolean; path: string; account: string; course?: string; runtimeFile?: string;
  /** Published sample tests; the runner supplies each test's own input, arguments and files. */
  tests: PublicTest[];
  /** SQL: the exercise dataset; labs: the setup script. Run loads it before the learner's code. */
  dataset?: string;
}
const notebookTests = (tests: PublicTest[] | undefined) => (tests ?? []).slice(0, 20);

function practiceTitle(workspace: Workspace, selectedTitle?: string): string {
  const usable = (value: string | undefined) => {
    const title = value?.replace(/\s+/g, ' ').trim();
    return title && !/^(?:programming|coding) exercise$/i.test(title) ? title.slice(0, 180) : undefined;
  };
  const title = usable(selectedTitle) || usable(workspace.project.title);
  if (title) return title;
  // Older services return a placeholder. Match the Practice tree's public question label.
  for (const line of workspace.project.brief.split(/\r?\n/)) {
    const label = line.replace(/^[# *\t]+|[# *\t]+$/g, '').replace(/\*\*/g, '');
    const title = usable(label);
    if (!/^(?:question|task|exercise):*$/i.test(label) && title) return title;
  }
  return 'Coding exercise · ' + workspace.project.question_id;
}

export function practiceContext(workspace: Workspace, account: string, course?: string, selectedTitle?: string): PracticeNotebook {
  const project = workspace.project, language = codeLanguage(workspace.draft.payload.language, true);
  if (!language || !project.languages.includes(language) || !/^[0-9a-f-]{36}$/i.test(project.question_id))
    throw new Error('This exercise cannot be opened in a programming notebook.');
  return {id:project.question_id, language, question:project.brief.slice(0,6000), title:practiceTitle(workspace, selectedTitle),
    starter:workspace.draft.payload.notebook.cells.filter(cell => cell.cell_type === 'code').map(cell => cell.source).join('\n\n'),
    assistance:project.code_assistance_allowed === true, path:'/practice-code/' + encodeURIComponent(project.question_id) + '/notebook-coach', account, course,
    tests:notebookTests(project.tests?.public),
    dataset:project.run_configuration?.sample_files?.find(file => file.name === 'dataset.sql' || file.name === 'lab_setup.sh')?.content};
}

export function generatedPractice(result: GeneratedExercise, id: string, account: string): PracticeNotebook {
  const language = codeLanguage(result.language);
  if (!language) throw new Error('This exercise language is unavailable.');
  const exercise = result.exercise;
  // Require the matching API update before opening newly generated content.
  const tests = result.validation === 'reference_execution' ? storedTests(result.tests) : [];
  const normalized = (value: string) => value.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
  if (tests.length !== 1 || tests[0].stdin !== exercise.example_input
      || normalized(tests[0].expected) !== normalized(exercise.expected_output))
    throw new Error('This service did not return a validated exercise sample. Update the service, or open a published Practice question.');
  return {id, account, language, title:exercise.title, course:result.course, starter:'', assistance:true, tests,
    path:'/notebook-coach/tutor', question:[exercise.title, exercise.task, 'Example input', exercise.example_input,
      'Expected output', exercise.expected_output].join('\n\n').slice(0,6000)};
}

const EXAMPLE_LABEL = /^(?:example input|expected output|sample input|sample output|input|output)$/i;
/**
 * The task as a learner reads it: the title as a heading and each example as literal text. Only the display
 * changes; Instructor and the service still receive the exact question text.
 */
export function questionMarkdown(question: string, title = ''): string {
  const blocks = question.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((block, i) => {
    if (i === 0 && title && block.trim() === title.trim()) return '### ' + block.trim();
    if (EXAMPLE_LABEL.test(block.trim())) return '**' + block.trim() + '**';
    if (i > 0 && EXAMPLE_LABEL.test(blocks[i - 1].trim()) && !block.trimStart().startsWith('```'))
      return '```text\n' + block.replace(/`{3,}/g, m => m.replace(/`/g, '\u02cb')) + '\n```';
    return block;
  }).join('\n\n');
}

export function practiceDocument(practice: PracticeNotebook): TutorNotebook {
  const notebook = emptyNotebook(); notebook.exerciseId = practice.id; notebook.title = practice.title.slice(0,300);
  notebook.cells.push({id:'practice-question', kind:'board', text:questionMarkdown(practice.question, practice.title).slice(0,6000), packet:{
    is_question_prompt:true, tutor_checkpoint_id:'practice:' + practice.id,
    practice_course:practice.course, practice_tests:practice.tests, tutor_practice_editor:{
      question_id:practice.id, checkpoint_id:'practice:' + practice.id, language:practice.language,
      starter:practice.starter, question:practice.question, source:'Practice exercise'},
  }});
  return notebook;
}

function storedTests(value: unknown): PublicTest[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0,20).filter((test): test is PublicTest => test && typeof test.id === 'string' && test.id.length <= 100
    && test.kind === 'stdio' && typeof test.stdin === 'string' && test.stdin.length <= 4000
    && typeof test.expected === 'string' && test.expected.length <= 4000);
}

/** Recover the local question context; saved drafts and conversation are loaded by the notebook store. */
export function savedPractice(notebook: TutorNotebook, account: string): PracticeNotebook | undefined {
  const id = notebook.exerciseId;
  if (!id || !/^(?:generated-[0-9a-f]{24}|[0-9a-f-]{36})$/i.test(id)) return;
  const packet = notebook.cells.find(cell => cell.id === 'practice-question')?.packet;
  const task = packet?.tutor_practice_editor as Record<string, unknown> | undefined;
  const language = typeof task?.language === 'string' ? codeLanguage(task.language) : undefined;
  if (!language || task?.question_id !== id || typeof task.question !== 'string' || !task.question.trim() || task.question.length > 6000) return;
  return {id, account, language, question:task.question, title:notebook.title, starter:'', assistance:true,
    course:typeof packet?.practice_course === 'string' ? packet.practice_course : undefined,
    tests:storedTests(packet?.practice_tests), path:id.startsWith('generated-') ? '/notebook-coach/tutor' : '/practice-code/' + id + '/notebook-coach'};
}
