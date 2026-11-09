// node scripts/study-summary.mjs P1.json P2.json ...: summarize exported Practice records for the five-student study
// (docs/vscode-five-student-study.md). Reads only counts and times; each file is one student.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node study-summary.mjs P1.json [P2.json ...]'); process.exit(2); }

const minutes = seconds => seconds == null ? '—' : (seconds / 60).toFixed(1);
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined; };
let students = 0, improved = 0;
const all = [];

for (const file of files) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.format !== 'dhimantai-practice-record/1') { console.error(`${file}: not a Practice record export`); process.exit(2); }
  // Written challenges have no pass condition, so the study measures coded problems only.
  const problems = record.problems.filter(p => p.kind !== 'written').sort((a, b) => a.opened.localeCompare(b.opened));
  students++;
  console.log(`\n${basename(file, '.json')}`);
  console.log('  problem                         solved   min   help  highest rung  independent');
  for (const p of problems) {
    const s = p.solved;
    console.log('  ' + p.title.slice(0, 30).padEnd(31) + (s ? 'yes' : 'no ').padEnd(9) + minutes(s?.secondsToSolve).padStart(4)
      + String(s ? s.helpBeforeSolve : p.ladder.question + p.ladder.hint + p.ladder.where + p.ladder.example + p.otherAsks).padStart(7)
      + String(s ? s.highestLevel : '—').padStart(14) + (s?.independent ? '  yes' : '  no'));
    all.push(p);
  }
  // Primary measure: the last scored problem is solved without help, faster than the first.
  const first = problems.find(p => p.solved), last = problems.at(-1);
  const better = last?.solved?.independent && (!first?.solved || first === last || last.solved.secondsToSolve < first.solved.secondsToSolve);
  if (better) improved++;
  console.log(`  last problem solved without help, faster than the first: ${better ? 'yes' : 'no'}`);
}

const solved = all.filter(p => p.solved);
console.log(`\n${students} students, ${all.length} problems, ${solved.length} solved, `
  + `${solved.filter(p => p.solved.independent).length} without help.`);
console.log(`Median minutes to solve: ${minutes(median(solved.map(p => p.solved.secondsToSolve)))}; `
  + `median highest rung: ${median(solved.map(p => p.solved.highestLevel)) ?? '—'}.`);
console.log(`Primary result: ${improved} of ${students} students solved their last problem without help, faster than their first `
  + `(target: at least 3 of 5).`);
