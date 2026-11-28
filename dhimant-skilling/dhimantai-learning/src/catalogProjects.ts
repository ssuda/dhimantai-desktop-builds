import { gitProjects } from './gitPractice';
import { debugProjects } from './architectureMemory';
import type { Course } from './api';
import { desktopProjectEnabled } from './desktopFeatures';

/** Bundled projects shared by the catalog and the course-project launcher. */
const bundledProjects = [
  {
    id: 'shelf-reading',
    level: 'Micro',
    title: 'Read a codebase · shelf',
    description: 'Explore a small Python book catalog with the mentor. Follow its command line, data and tests before proposing a change.',
    difficulty: 'Beginner',
    estimatedTime: '1–2 hours',
    outcomes: [
      'Map a repository and locate its entry point.',
      'Trace data through functions and predict output.',
      'Explain what passing tests do and do not prove.',
    ],
  },
  {
    id: 'rich-reading',
    level: 'Minor',
    title: 'Read a codebase · Rich',
    description: 'Navigate the real Rich Python library with the mentor, tracing how text and tables become terminal output.',
    difficulty: 'Intermediate',
    estimatedTime: '3–5 hours',
    outcomes: [
      'Navigate a large repository using focused questions.',
      'Trace rendering across methods and modules.',
      'Support a behavior explanation with source code and tests.',
    ],
  },
  {
    id: 'course-agent',
    level: 'Major',
    title: 'Build a Course Research Agent',
    description: 'Build a Python agent that searches course documents and answers with source evidence, across ten guided milestones.',
    difficulty: 'Intermediate',
    estimatedTime: '6–10 hours',
    outcomes: [
      'Implement document search and validated tool calls.',
      'Build an agent loop with evidence checks and error recovery.',
      'Evaluate test cases and compare scripted and live model behavior.',
    ],
  },
  {
    id: 'shelf',
    level: 'Minor',
    title: 'Fix a repository bug · shelf',
    description: 'Investigate a search bug in a small Python repository, using its Git history, a bug report and your own regression test.',
    difficulty: 'Beginner',
    estimatedTime: '2–3 hours',
    outcomes: [
      'Reproduce a reported bug and investigate Git history.',
      'Write a regression test that catches the original defect.',
      'Make and explain a focused fix in a Git commit.',
    ],
  },
  {
    id: 'market-checkout', level: 'Micro', title: 'Checkout previews',
    description: 'Trace an unexpected receipt, separate pricing from storage, and verify the repair with the mentor.',
    difficulty: 'Beginner', estimatedTime: '20–30 minutes',
    outcomes: ['Trace a side effect.', 'Test a decision independently of storage.'],
  },
  {
    id: 'field-dispatch', level: 'Micro', title: 'Field service dispatch',
    description: 'Investigate a dispatch report independently. Record your diagnosis, repair the service and check its behavior.',
    difficulty: 'Intermediate', estimatedTime: '20–30 minutes',
    outcomes: ['Locate the cause of a customer report.', 'Verify a repair against the service contract.'],
  },
  ...[
    {id:'parcel-pickup', title:'Parcel pickup', description:'Investigate a collection report and verify your repair.'},
    {id:'museum-entry', title:'Museum entry', description:'Investigate a visitor’s ticket report across two sales channels.'},
    {id:'workshop-enrolment', title:'Workshop enrolment', description:'Investigate a group booking report and verify both entry points.'},
  ].map(project => ({...project, level:'Micro', difficulty:'Intermediate', estimatedTime:'20–30 minutes',
    outcomes:['Identify the cause of a reported behavior.', 'Verify a repair against the public contract.']})),
  ...Object.entries(debugProjects).map(([id, project]) => ({
    id, title:project.title, description:project.description, level:'Micro', difficulty:'Intermediate', estimatedTime:'20–30 minutes',
    outcomes:['Locate the bug and repair the reported behavior.', 'Write a test that catches the original failure.'],
  })),
  ...Object.entries(gitProjects).map(([id,title]) => ({id,title, level:'Micro', difficulty:'Intermediate', estimatedTime:'20–30 minutes',
    description:id === 'festival-desk' ? 'Prepare the volunteer desk changes for review.' : 'Integrate changes from two orchard teams.',
    outcomes:['Work on a branch and make focused commits.', 'Resolve a merge conflict while preserving both changes.']})),
] as const;

export const CATALOG_PROJECTS = bundledProjects.filter(project => desktopProjectEnabled(project.id));

/** Companion courses for bundled projects. */
export const PROJECT_COURSES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.keys(gitProjects).map(id => [id, 'python'])),
  ...Object.fromEntries(Object.keys(debugProjects).map(id => [id, 'python'])),
  'market-checkout': 'python',
  'field-dispatch': 'python',
  'parcel-pickup': 'python',
  'museum-entry': 'python',
  'workshop-enrolment': 'python',
  'shelf': 'python',
  'course-agent': 'build-ai-agents',
  'shelf-reading': 'engineering-code-reading',
  'rich-reading': 'engineering-code-reading',
};

export function projectCourseChoices(projectId: string, courses: readonly Course[]) {
  return courses.flatMap(course => {
    // Before the service advertised project compatibility it accepted only the subject Python.
    const access = course.project_coach === undefined && course.name === 'Python' && course.chapters.some(ch => !ch.locked && !ch.expired)
      ? {course_id: 'python'} : course.project_coach;
    if (!access) return [];
    const companion = access.course_id === PROJECT_COURSES[projectId];
    return [{label: course.name, companion, description: companion ? 'Companion course' : undefined,
      detail: course.chapters.some(ch => ch.locked) ? 'Project Mentor guidance with active chapter access' : 'Project Mentor guidance'}];
  }).sort((a, b) => Number(b.companion) - Number(a.companion));
}

export function projectAccessEnded(projectId: string, courses: readonly {id: string; expired?: boolean}[] = [], lessons?: readonly Course[]) {
  const course = PROJECT_COURSES[projectId];
  return !!lessons && !!courses.find(c => c.id === course)?.expired && !projectCourseChoices(projectId, lessons).length;
}
