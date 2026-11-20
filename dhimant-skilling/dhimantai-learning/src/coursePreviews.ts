/** Ungraded catalog samples drawn from the worked examples in each free first chapter. */
export interface CoursePreview {
  title: string;
  source: string;
  question: string;
  answers: {label: string; feedback: string; correct?: boolean}[];
}

export const coursePreviews = new Map<string, CoursePreview>([
  ['algorithms-python', {
    title: 'Trace a recursive sum',
    source: [
      'def nested_sum(item):',
      '    if not isinstance(item, list):',
      '        return item',
      '    return sum(nested_sum(part) for part in item)',
      '',
      'print(nested_sum([1, [2, 3], [[4], 5], []]))',
    ].join('\n'),
    question: 'What does this call print?',
    answers: [
      {label: '4', feedback: 'There are four items in the outer list. Follow each recursive call into the inner lists and try again.'},
      {label: '15', correct: true, feedback: 'Correct. The four parts return 1, 5, 9 and 0. Their sum is 15.'},
      {label: 'An error', feedback: 'The empty list is valid. Its sum is zero. What do the other three parts contribute?'},
    ],
  }],
  ['python-backend-fastapi', {
    title: 'Predict an API response',
    source: [
      'class CreateReport(BaseModel):',
      '    model_config = ConfigDict(',
      '        strict=True,',
      '        extra="forbid",',
      '    )',
      '    title: str = Field(',
      '        min_length=1,',
      '        max_length=120,',
      '    )',
    ].join('\n'),
    question: 'A client posts {"title": 42} to /v1/reports with valid headers. Which HTTP status will it receive?',
    answers: [
      {label: '201 Created', feedback: 'The route creates a report only after validation. Check the type of the title in the request.'},
      {label: '404 Not Found', feedback: 'The route exists. Look at the request model and the value the client sent.'},
      {label: '422 Unprocessable Entity', correct: true, feedback: 'Correct. Strict validation requires a string title. FastAPI rejects the number before the route creates a report.'},
    ],
  }],
]);
