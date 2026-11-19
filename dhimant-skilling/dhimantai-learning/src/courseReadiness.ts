import {firstPandasCell} from './starterExercises';
import type { CourseEngine } from './courseEngine';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NotebookCells } from './notebookCells';

export const readyMessage = 'Course environment ready';
export const courseExamples: Record<string, string> = {
  python: `print("${readyMessage}")`,
  javascript: `console.log("${readyMessage}")`,
  typescript: `const message: string = "${readyMessage}"; console.log(message)`,
  cpp: `#include <iostream>\nint main() { std::cout << "${readyMessage}\\n"; }`,
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

/** A plain Python process cannot detect notebook initialization or profile failures. */
export async function verifyCourseNotebook(engine: CourseEngine, imports: string[] = []) {
  // Own the directory here: a timeout/restart or partial startup clears cells.directory.
  const folder = await mkdtemp(join(engine.root, '.notebook-'));
  const cells = new NotebookCells(() => ({}), async () => engine, async () => folder, 60000);
  let failed = false, warning: string | undefined;
  try {
    const checkPandas = imports.includes('pandas');
    const expected = checkPandas ? readyMessage + '\n10' : readyMessage;
    const result = await cells.run('python',
      'import importlib\nfor name in ' + JSON.stringify(['IPython', 'ipykernel', 'nbformat', ...imports])
      + ':\n    importlib.import_module(name)\n' + courseExamples.python + (checkPandas ? '\n' + firstPandasCell : ''));
    if (result.status !== 'exited' || result.exit_code !== 0 || result.truncated || result.stdout.trim().replace(/\r\n/g,'\n') !== expected)
      throw new Error('The Python notebook check failed. '
        + (result.stderr.trim() || result.stdout.trim() || result.status).slice(-1500)
        + ' Choose Set up / rebuild course in the runtime dropdown to retry.');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await cells.close();
      try {
        await rm(folder, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
      } catch (error) {
        // Antivirus/indexers can retain Windows handles after the child has closed.
        // An exhausted cleanup must not turn a working runtime into a failed course check.
        warning = 'Temporary notebook files could not be removed because the folder is busy or inaccessible. '
          + 'You can continue running code. Close any terminal or app using this folder; '
          + 'after closing dhimantAI, you can remove this temporary folder: ' + folder;
        console.warn(warning, error);
      }
    } catch (error) {
      if (!failed) throw error;
      // Keep the original import/startup error and leave a still-running process's files alone.
      console.warn('Notebook check cleanup also failed; temporary files were kept at ' + folder, error);
    }
  }
  return warning;
}
