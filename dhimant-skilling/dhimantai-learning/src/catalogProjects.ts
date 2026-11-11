/** Bundled projects shared by the catalog and the course-project launcher. */
export const CATALOG_PROJECTS = [
  {
    id: 'shelf-reading',
    level: 'Micro',
    title: 'Read a codebase · shelf',
    description: 'Explore a small Python book catalog with Coach. Follow its command line, data and tests before proposing a change.',
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
    description: 'Navigate the real Rich Python library with Coach, tracing how text and tables become terminal output.',
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
] as const;

/** Projects that belong to a catalog course follow that course's access period. Other bundled projects stay open. */
export const PROJECT_COURSES: Readonly<Record<string, string>> = {
  'shelf': 'python',
  'course-agent': 'build-ai-agents',
  'shelf-reading': 'engineering-code-reading',
  'rich-reading': 'engineering-code-reading',
};

export function projectAccessEnded(projectId: string, courses: readonly {id: string; expired?: boolean}[] = []) {
  const course = PROJECT_COURSES[projectId];
  return !!course && !!courses.find(c => c.id === course)?.expired;
}
