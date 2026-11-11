import type { CourseEngine } from './courseEngine';

export const readyMessage = 'Course environment ready';
export const courseExamples: Record<string, string> = {
  python: `print("${readyMessage}")`,
  javascript: `console.log("${readyMessage}")`,
  typescript: `const message: string = "${readyMessage}"; console.log(message)`,
  c: `#include <stdio.h>\nint main(void) { puts("${readyMessage}"); }`,
  java: `public class Main { public static void main(String[] args) { System.out.println("${readyMessage}"); } }`,
  go: `package main\nimport "fmt"\nfunc main() { fmt.Println("${readyMessage}") }`,
  rust: `fn main() { println!("${readyMessage}"); }`,
  sql: `SELECT '${readyMessage}' AS message`,
  bash: `echo '${readyMessage}'`, zsh: `echo '${readyMessage}'`,
  pglab: `psql -Atc "SELECT '${readyMessage}'"`
};

/** Exercise the same runner as learner code before reporting a usable toolchain. */
export async function verifyCourseLanguage(engine: Pick<CourseEngine, 'run'>, language: string) {
  const source = courseExamples[language];
  if (!source) throw new Error('Unsupported course language.');
  const result = await engine.run(language, { source, stdin: '', argv: [], files: [] });
  // SQL prints its result as a table; every other language prints the message alone.
  const printed = language === 'sql' ? result.stdout.split('\n').some(line => line.trim() === readyMessage) : result.stdout.trim() === readyMessage;
  if (result.status !== 'exited' || result.exit_code !== 0 || !printed)
    throw new Error(`The ${language} course check failed. ${result.stderr.trim() || result.status}. Choose Set up / rebuild course in the runtime dropdown to retry.`);
}
