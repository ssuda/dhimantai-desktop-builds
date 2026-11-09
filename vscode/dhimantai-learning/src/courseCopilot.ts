// Exact course names from the reviewed curriculum. Courses about building agents
// do not implicitly permit an agent to write the learner's implementation.
const AI_CODING_COURSES = new Set(['use ai coding help with verification']);

export function courseAllowsCopilot(course?: string): boolean {
  return typeof course === 'string' && AI_CODING_COURSES.has(course.trim().toLowerCase());
}
