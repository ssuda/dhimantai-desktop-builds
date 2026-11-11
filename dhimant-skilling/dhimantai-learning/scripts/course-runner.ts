// Runs only inside the course container. Keep execution and evidence semantics identical to the desktop runner.
import { runLocally, runPublicTests, traceLocally } from '../src/localRunner';

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { operation, language, input, tests } = JSON.parse(Buffer.concat(chunks).toString());
  const base = '/opt/dhimantai/';
  let result;
  switch (operation) {
    case 'run':
      result = await runLocally(language, input);
      break;
    case 'tests':
      result = await runPublicTests(language, input.source, tests, base + 'pycall.py');
      break;
    case 'trace':
      result = await traceLocally(base + 'pytrace.py', input);
      break;
    default:
      throw new Error('Unknown runtime operation');
  }
  process.stdout.write(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
