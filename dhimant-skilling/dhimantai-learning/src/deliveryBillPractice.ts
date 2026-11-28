import type {Execution, PublicTest} from './api';

/** The published delivery-bill exercise asks for an independent boundary demonstration. */
const deliveryBillId = '75141e8f-b5ce-56c8-befc-c325019517bf';
export type BillSample = {call:string; args:string[]; expected:string};

export function deliveryBillSamples(id: string, tests: PublicTest[]): BillSample[] | undefined {
  if (id !== deliveryBillId || !tests.length) return;
  const samples: BillSample[] = [];
  for (const test of tests) {
    const call = test.call ?? '';
    const match = /^bill\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(call);
    if (test.kind !== 'function' || !match || !/^\d+$/.test(test.expected.trim())) return;
    samples.push({call, args:match.slice(1), expected:test.expected.trim()});
  }
  return samples;
}

export function deliveryBillFeedback(samples: BillSample[], run?: Execution): string {
  if (run && (run.status !== 'exited' || run.exit_code !== 0))
    return 'Practice checks incomplete. Fix the run error, then run the public calls and your boundary call again.';
  const calls = run?.lessonTrace?.functionCalls ?? [];
  const matches = (a:string[], b:string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const missing = samples.filter(sample => !calls.some(call => matches(call.args, sample.args) && call.result === sample.expected));
  const legal = calls.filter(call => call.args.length === 3 && call.args.every(v => /^\d{1,80}$/.test(v)));
  const wrong = legal.find(call => {
    const [quantity, unitPrice, delivery] = call.args.map(value => BigInt(value));
    return call.result !== String(quantity * unitPrice + delivery);
  });
  // A repeated public input is already covered. A distinct legal input on any zero boundary counts.
  const boundary = legal.find(call => call.args.includes('0') && !samples.some(sample => matches(call.args, sample.args)));
  if (!missing.length && boundary && !wrong)
    return 'Practice checks complete. Your run returned the expected values for the public calls and bill('
      + boundary.args.join(', ') + ') returned ' + boundary.result + '. You can submit for grading.';
  const steps = ['Practice checks incomplete.'];
  if (wrong) steps.push('In your run, bill(' + wrong.args.join(', ') + ') returned ' + wrong.result + '. Compare that value with the bill you predicted.');
  if (missing.length) steps.push('Below your function, run ' + missing.map(sample => 'print(' + sample.call + ')').join(' and ')
    + ' and check for ' + missing.map(sample => sample.expected).join(' and ') + '.');
  else steps.push('Your run checked the public examples.');
  if (!boundary) steps.push('Add a print call with zero items and a delivery charge of your choice. Predict the charge, then choose Run.');
  if (run?.lessonTrace?.limited) steps.push('Only the first part of this run was observed.');
  if (run && !run.lessonTrace?.functionCalls) steps.push('This runtime did not report the calls made during Run.');
  return steps.join(' ');
}
