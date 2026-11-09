// Runs inside a sandbox image: the same corpus through the real sandbox runner (program.py) and the
// extension's local runner, then compares them field by field and against the ground-truth error line.
//   node out/test/parity/parity.js <language>
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runLocally, Toolchains } from '../../src/localRunner';
import { errorLocation } from '../../src/learning';
import { CORPUS } from './corpus';

const language = process.argv[2];
const includeSlow = process.env.PARITY_SLOW === '1';
const python = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0)!;
// The image's own tool locations, as the sandbox uses them.
const toolchains: Toolchains = language === 'typescript' ? { tsc: '/opt/typescript/node_modules/typescript/bin/tsc' } : {};

function sandbox(c: { source: string; argv?: string[]; files?: { name: string; content: string }[]; stdin?: string }) {
  const request = { mode: 'program', language, notebook: { cells: [{ cell_type: 'code', source: c.source }] }, argv: c.argv ?? [], files: c.files ?? [], stdin: c.stdin ?? '' };
  const out = execFileSync(python, ['/opt/project/program.py'], { input: JSON.stringify(request), maxBuffer: 1 << 24, env: { ...process.env } });
  return JSON.parse(out.toString()).execution;
}

async function main() {
  if (!existsSync('/opt/project/program.py')) throw new Error('Run inside a dhimantai-project image.');
  const rows = [];
  for (const c of CORPUS[language] ?? []) {
    if (c.slow && !includeSlow) continue;
    const input = { source: c.source, argv: c.argv ?? [], stdin: c.stdin ?? '', files: c.files ?? [] };
    const reference = sandbox(c);
    const local = await runLocally(language, input, toolchains);
    const refLine = errorLocation(language, reference.stderr ?? '')?.line ?? null;
    const localLine = errorLocation(language, local.stderr)?.line ?? null;
    const checks = {
      status: reference.status === local.status,
      exit_code: reference.exit_code === local.exit_code,
      stdout: reference.stdout === local.stdout,
      stderr_presence: !!reference.stderr === !!local.stderr,
      line_parity: refLine === localLine,
      line_truth: c.line === undefined || localLine === c.line,
    };
    rows.push({
      language, case: c.name, ok: Object.values(checks).every(Boolean), checks,
      sandbox: { status: reference.status, exit_code: reference.exit_code, line: refLine, stdout: reference.stdout, stderr: (reference.stderr ?? '').slice(0, 300) },
      local: { status: local.status, exit_code: local.exit_code, line: localLine, stdout: local.stdout, stderr: local.stderr.slice(0, 300), command: local.command },
    });
  }
  process.stdout.write(JSON.stringify(rows) + '\n');
}

main().catch(error => { console.error(error); process.exit(2); });
