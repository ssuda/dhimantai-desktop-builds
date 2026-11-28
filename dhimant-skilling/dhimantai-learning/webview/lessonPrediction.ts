import type { Execution, LessonTrace, LessonTraceStep } from '../src/api';
import { comparePrediction, predictionFeedback } from '../src/learningLoop';

/** Older written cards sometimes embed the executable cell's submission directions. */
export function writtenAnswerDirections(markdown: string) {
  const parts = markdown.split(/(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[ \t]*$)/gm);
  const field = /(?:the )?[`*"'“‘]*I expect it to print[`*"'”’]*\s+(?:input\s+)?(?:field|box)\b/gi;
  if (!parts.some((part, i) => i % 2 === 0 && part.search(field) >= 0)) return markdown;
  return parts.map((part, i) => i % 2 ? part : part.replace(field, 'the message box')
    .replace(/\b(?:click|press|select|choose|tap)(?: on)?\s+(?:the\s+)?[`*"'“‘]*Run\b[`*"'”’]*(?:\s+button)?/gi, 'submit your answer (↑)')
    .replace(/\b(?:clicking|pressing)\s+[`*"'“‘]*Run\b[`*"'”’]*/gi, 'submitting your answer (↑)')).join('');
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function traceView(trace: LessonTrace, lines: string[]) {
  const panel = document.createElement('details');
  panel.className = 'lesson-trace';
  panel.open = true;
  panel.append(textElement('summary', 'Step through this run'));
  const source = document.createElement('pre');
  const rows = lines.map((line, index) => textElement('span', (index + 1) + '  ' + line));
  source.append(...rows);
  const state = document.createElement('div');
  state.setAttribute('aria-live', 'polite');
  const position = document.createElement('strong'), variables = document.createElement('dl');
  variables.className = 'trace-values';
  const printed = document.createElement('pre');
  state.append(position, variables, printed);
  const previous = textElement('button', '← Previous'), next = textElement('button', 'Next →');
  previous.type = next.type = 'button';
  const nav = document.createElement('div');
  nav.className = 'trace-nav'; nav.append(previous, next);
  panel.append(source, nav, state);
  if (trace.limited) panel.append(textElement('small', 'Showing the first 160 steps.'));
  let index = 0;
  const show = (at: number) => {
    rows[trace.steps[index].line - 1]?.removeAttribute('aria-current');
    index = at;
    const step = trace.steps[at], row = rows[step.line - 1];
    row?.setAttribute('aria-current', 'step');
    if (panel.open && row) source.scrollTop = row.offsetTop - source.clientHeight / 2;
    position.textContent = 'Step ' + (at + 1) + ' of ' + trace.steps.length + ' · Line ' + step.line
      + (step.function === '<module>' ? '' : ' in ' + step.function);
    variables.replaceChildren();
    for (const name of new Set([...Object.keys(step.locals), ...Object.keys(step.previous)])) {
      const current = step.locals[name] ?? '(removed)';
      const changed = Object.hasOwn(step.previous, name);
      const old = step.previous[name];
      const value = changed ? old == null ? current + ' (new)' : old + ' → ' + current : current;
      const cell = textElement('dd', value);
      if (changed) cell.className = 'trace-change';
      variables.append(textElement('dt', name), cell);
    }
    if (!variables.children.length) variables.append(textElement('dd', 'No variables on this line.'));
    printed.hidden = !step.printed;
    printed.textContent = 'Output from this line\n' + (step.printed ?? '');
    previous.disabled = at === 0; next.disabled = at === trace.steps.length - 1;
  };
  previous.onclick = () => show(index - 1);
  next.onclick = () => show(index + 1);
  panel.ontoggle = () => { if (panel.open) show(index); };
  show(0);
  return { panel, jump: (at: number) => { panel.open = true; show(at); } };
}

function arithmetic(expression: string, step: LessonTraceStep, result: string) {
  const binary = /^([a-zA-Z_]\w*|-?\d+)\s*(\/\/|[%+*-])\s*([a-zA-Z_]\w*|-?\d+)$/.exec(expression);
  if (!binary) return '';
  const value = (token: string) => Object.hasOwn(step.previous, token) ? step.previous[token] : step.locals[token] ?? token;
  const left = value(binary[1]), right = value(binary[3]), operator = binary[2];
  if (![left, right, result].every(number => typeof number === 'string' && /^-?\d+$/.test(number))) return '';
  const meaning = operator === '%' ? ' The % operator gives the remainder.' : operator === '//' ? ' The // operator rounds the quotient down.' : '';
  return 'Here ' + left + ' ' + operator + ' ' + right + ' = ' + result + '.' + meaning;
}

/** Link a difference only to text actually written on that output line during this run. */
function explainLine(trace: LessonTrace, lines: string[], difference: NonNullable<ReturnType<typeof comparePrediction>['firstSurprise']>) {
  if (!trace.outputAligned || difference.missing === 'output') return;
  const at = trace.steps.findIndex(step => {
    if (!step.printed || step.outputLine === undefined) return false;
    const emitted = step.printed.replace(/\n$/, '').split('\n');
    return emitted[difference.line - step.outputLine] === difference.actual;
  });
  if (at < 0) return;
  const step = trace.steps[at], statement = lines[step.line - 1]?.trim() ?? '';
  const words = difference.predicted.trim().split(/\s+/);
  const actual = difference.actual.trim().split(/\s+/);
  const token = actual.findIndex((value, i) => words[i] !== value);
  const args = /^print\(([^()]*)\)\s*(?:#.*)?$/.exec(statement)?.[1].split(',').map(arg => arg.trim());
  const argument = args?.length === actual.length ? args[token] : undefined;
  const prefix = token === 1 ? 'The first value matches. ' : '';
  if (argument && Object.hasOwn(step.locals, argument) && step.locals[argument] === actual[token]) {
    const name = argument;
    // A previous invocation of a function can have different bindings of the same name.
    const origin = trace.steps.slice(0, at).map(s => s.frame === step.frame && s.locals[name] === step.locals[name]
      && (Object.hasOwn(s.previous, name) || lines[s.line - 1]?.trim().match(/^(\w+)\s*=(?!=)/)?.[1] === name)).lastIndexOf(true);
    const assignment = origin >= 0 ? lines[trace.steps[origin].line - 1].trim() : '';
    let why = '';
    if (origin >= 0) {
      const change = trace.steps[origin];
      why = 'Line ' + change.line + ' ran ' + assignment + '. ';
      const rhs = /^\w+\s*=\s*([^#]+)/.exec(assignment)?.[1].trim();
      const calculation = rhs && arithmetic(rhs, change, step.locals[name]);
      if (calculation) why += calculation + ' ';
    }
    return {at:origin >= 0 ? origin : at, explanation:prefix + why + 'Line ' + step.line + ' printed ' + name + ' with its value of ' + step.locals[name] + '.'};
  }
  if (argument) {
    const calculation = arithmetic(argument, step, actual[token]);
    if (calculation) return {at, explanation:prefix + 'Line ' + step.line + ' evaluated ' + argument + '. ' + calculation};
  }
  const bindings = Object.entries(step.locals).filter(([name]) => statement.match(/[\p{L}_][\p{L}\p{N}_]*/gu)?.includes(name))
    .map(([name, value]) => name + ' = ' + value).slice(0, 4);
  return {at, explanation:'Line ' + step.line + ' ran ' + statement + (bindings.length ? ' with ' + bindings.join(', ') : '')
    + '. Follow that line in the trace to see how the program produced this output.'};
}

export function lessonPrediction(source: string, prediction: string, run: Execution) {
  const block = document.createElement('section');
  const lines = source.replace(/\n$/, '').split('\n'), trace = run.lessonTrace;
  const viewer = trace?.steps.length ? traceView(trace, lines) : undefined;
  if (run.status === 'exited' && run.exit_code === 0 && !run.truncated) {
    const silent = !run.stdout && /^(?:\(?no (?:printed )?output\)?|nothing)$/i.test(prediction.trim());
    const comparison = comparePrediction(silent ? '' : prediction, run.stdout);
    block.className = 'lesson-prediction';
    const title = textElement('strong', comparison.exact ? 'Prediction matched' : 'Prediction differs');
    const columns = document.createElement('div'); columns.className = 'prediction-columns';
    const output = (heading: string, value: string) => {
      const column = document.createElement('div');
      column.append(textElement('strong', heading), textElement('pre', value));
      return column;
    };
    const predicted = output('Your prediction', prediction);
    if (!comparison.exact) predicted.className = 'prediction-incorrect';
    columns.append(predicted, output('Actual output', run.stdout || '(no output)'));
    block.append(title, columns);
    if (comparison.firstSurprise) {
      const explanation = trace && explainLine(trace, lines, comparison.firstSurprise);
      const detail = textElement('p', explanation && !comparison.formatOnly && !comparison.firstSurprise.missing
        ? explanation.explanation
        : predictionFeedback(comparison) + ' ' + (explanation?.explanation ?? (viewer
          ? 'Step through the run and follow the variables used by each output statement.'
          : 'Follow the values in each output statement. You can ask Instructor about this run.')));
      block.append(detail);
      if (explanation && viewer) {
        const jump = textElement('button', 'Show line ' + trace!.steps[explanation.at].line + ' in trace');
        jump.type = 'button'; jump.onclick = () => viewer.jump(explanation.at);
        block.append(jump);
      }
    }
  }
  if (viewer) block.append(viewer.panel);
  return block;
}
