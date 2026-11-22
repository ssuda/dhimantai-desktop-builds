export const firstPandasCell = 'import pandas as pd\nsales = pd.DataFrame({"units": [2, 5, 3]})\nprint(sales["units"].sum())';

/** Short first-chapter exercises a learner can finish before the course runtime is ready: predict first, then run it.
 * `why` answers each wrong choice with its likely misconception and a question, without giving the answer away;
 * `hint` covers a choice without one. */
export const starterExercises = [
  {
    courseId: 'ai-at-work', courseTitle: 'AI at Work', goal: 'Use AI at work',
    activity: 'Check an AI-written message against its source.', preparation: 'No coding experience needed.',
    question: 'Your meeting notes say “delivery date to be confirmed”. An AI draft says “delivery is Friday”. What should you send?',
    choices: ['The Friday date from the draft', 'A message saying the date still needs confirmation'],
    why: ['Friday appears only in the AI draft. Can you find it anywhere in your notes?', ''],
    correct: 1, hint: 'Which detail can you support with the original notes?',
    feedback: 'The notes leave the date open. Keeping that uncertainty prevents a made-up commitment.',
  },
  {
    courseId: 'c-programming', courseTitle: 'C Programming', goal: 'Write my first program',
    activity: 'Predict what a short C program will print.', preparation: 'No coding experience needed.',
    question: 'There are four tickets and three more arrive. Which value will this program print?',
    language: 'c', source: '#include <stdio.h>\nint main(void) {\n    int tickets = 4;\n    tickets = tickets + 3;\n    printf("%d\\n", tickets);\n    return 0;\n}',
    choices: ['4', '3', '7'], correct: 2,
    why: ['4 is the value before the second line runs. What does tickets = tickets + 3 store?', '3 is the amount added. Which value ends up stored in tickets?', ''],
    hint: 'Add three to the original value, then read the value stored in tickets.',
    feedback: 'The assignment stores 7 in tickets. printf reads that updated value.',
  },
  {
    courseId: 'data-science-python', courseTitle: 'Data Science with Python', goal: 'Explore data with Python',
    activity: 'Predict a result from a small sales table.', preparation: 'For students who know Python basics.',
    language: 'python', source: firstPandasCell,
    question: 'A pandas sales table has three values in its units column: 2, 5 and 3. What will sales["units"].sum() return?',
    choices: ['3', '10', '5'], correct: 1,
    why: ['3 is how many rows the table has. sum() adds the values stored in those rows. What are they?', '', '5 is only one row. sum() adds the value in every row of the column. What are the other rows?'],
    hint: 'sum() adds every value in the column. How does that differ from counting rows?',
    feedback: 'The three rows contain 10 units altogether. Counting the rows would give 3.',
  },
];
