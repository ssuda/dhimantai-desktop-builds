import type { StudyQuiz } from '../src/studyContent';
import { renderBoard } from './markdown';

/** Local practice only. Scores never enter the learning-evidence pipeline. */
export function showStudyQuiz(root: HTMLElement, questions: StudyQuiz[], finish: () => void) {
  if (!questions.length) { root.replaceChildren(); return; }
  let current = 0, view: 'questions' | 'results' | 'review' = 'questions';
  let started = performance.now(), elapsedSeconds = 0;
  const answers: (number | undefined)[] = questions.map(() => undefined);
  const button = (text: string, click: () => void, secondary = true) => {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
    if (secondary) element.className = 'secondary'; element.onclick = click; return element;
  };
  function render(focus = false, feedbackFocus = false) {
    root.replaceChildren();
    const answered = answers.filter(answer => answer !== undefined).length;
    const complete = answered === questions.length;
    const reviewing = view === 'review';
    if (view === 'results') {
      const summary = document.createElement('section'); summary.className = 'quiz-result';
      const heading = document.createElement('h3'); heading.textContent = 'Quiz completed!'; heading.tabIndex = -1;
      const note = document.createElement('p'); note.textContent = 'You have completed this chapter quiz. Review your answers to revisit the explanations.';
      const score = answers.filter((answer, index) => answer === questions[index].correct).length;
      const metrics = document.createElement('dl'); metrics.className = 'quiz-metrics';
      const minutes = Math.floor(elapsedSeconds / 60), seconds = elapsedSeconds % 60;
      for (const [label, value] of [['Correct answers', `${score} / ${questions.length}`],
        ['Practice score', `${Math.round(score / questions.length * 100)}%`],
        ['Time taken', minutes ? `${minutes} min ${seconds} sec` : `${seconds} sec`]]) {
        const metric = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
        term.textContent = label; detail.textContent = value; metric.append(term, detail); metrics.append(metric);
      }
      const actions = document.createElement('div'); actions.className = 'quiz-result-actions';
      actions.append(button('Review answers', () => { view = 'review'; render(true); }), button('Finish quiz', finish, false));
      summary.append(heading, note, metrics, actions); root.append(summary);
      if (focus) { heading.focus({preventScroll:true}); summary.scrollIntoView?.({block:'start'}); }
      return;
    }
    const progress = document.createElement('div'); progress.className = 'quiz-progress';
    const label = document.createElement('p'); label.textContent = reviewing
      ? `Reviewing ${questions.length} questions` : `Question ${current + 1} of ${questions.length} · ${answered} answered`;
    const meter = document.createElement('progress'); meter.max = questions.length; meter.value = answered;
    meter.setAttribute('aria-label', 'Questions answered'); progress.append(label, meter); root.append(progress);
    if (reviewing) {
      const actions = document.createElement('nav'); actions.className = 'quiz-review-actions'; actions.setAttribute('aria-label', 'Answer review');
      actions.append(button('Back to results', () => { view = 'results'; render(true); }),
        button('Retry quiz', () => { answers.fill(undefined); current = 0; view = 'questions'; started = performance.now(); elapsedSeconds = 0; render(true); })); root.append(actions);
    }
    (reviewing ? questions.map((_, index) => index) : [current]).forEach(index => {
      const question = questions[index], answer = answers[index];
      const group = document.createElement('fieldset'); group.className = 'quiz-question';
      const legend = document.createElement('legend'); legend.innerHTML = renderBoard(question.question); legend.tabIndex = -1;
      group.append(legend);
      question.options.forEach((option, choice) => {
        const selected = answer === choice, correct = answer !== undefined && choice === question.correct;
        const optionButton = button('', () => { if (answers[index] !== undefined) return; answers[index] = choice; render(true, true); });
        optionButton.className = 'quiz-option'; optionButton.disabled = answer !== undefined;
        optionButton.setAttribute('aria-pressed', String(selected));
        if (selected) optionButton.classList.add('selected');
        if (correct) optionButton.classList.add('correct');
        if (selected && !correct) optionButton.classList.add('incorrect');
        const letter = document.createElement('span'); letter.className = 'option-letter'; letter.textContent = 'ABCD'[choice];
        const text = document.createElement('span'); text.className = 'option-text'; text.innerHTML = renderBoard(option);
        const state = document.createElement('span'); state.className = 'option-state';
        state.textContent = correct ? (selected ? '✓ Your answer · Correct' : '✓ Correct answer') : selected ? '× Your answer' : '';
        optionButton.append(letter, text, state); group.append(optionButton);
      });
      if (answer !== undefined) {
        const feedback = document.createElement('div'); feedback.className = 'quiz-feedback'; feedback.setAttribute('role', 'status');
        const outcome = document.createElement('strong'); outcome.textContent = answer === question.correct ? 'Correct.' : `The correct answer is ${'ABCD'[question.correct]}.`;
        const explanation = document.createElement('div'); explanation.innerHTML = renderBoard(question.explanation);
        feedback.append(outcome, explanation); group.append(feedback);
      }
      root.append(group);
    });
    if (!reviewing) {
      const nav = document.createElement('nav'); nav.className = 'quiz-navigation'; nav.setAttribute('aria-label', 'Quiz questions');
      const previous = button('← Previous', () => { current--; render(true); }); previous.disabled = current === 0;
      const last = current === questions.length - 1;
      const next = button(last ? 'Finish quiz' : 'Next →', () => {
        if (last) {
          if (!complete) return;
          elapsedSeconds = Math.max(0, Math.round((performance.now() - started) / 1000)); view = 'results';
        } else current++;
        render(true);
      }, !last);
      next.disabled = last && !complete;
      if (next.disabled) next.title = 'Answer every question to finish the quiz.';
      nav.append(previous, next); root.append(nav);
    }
    if (focus) {
      const target = root.querySelector<HTMLElement>(feedbackFocus ? '.quiz-feedback' : '.quiz-question legend');
      if (target) { target.tabIndex = -1; target.focus({preventScroll:true}); target.scrollIntoView?.({block:'nearest'}); }
    }
  }
  render();
}
