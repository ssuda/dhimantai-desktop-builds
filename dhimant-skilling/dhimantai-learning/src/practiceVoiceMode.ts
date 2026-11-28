/** Flutter's regular Practice mode accepts the exercise as part of the LiveKit switch_mode RPC. */
export function practiceVoiceMode(id: string, title: string, question: string, subject: string, type: 'coding' | 'written') {
  const initial = { question_id: id, subject: subject.slice(0, 180), topic: title.slice(0, 300), question_type: type, question_text: question };
  const payload = { mode: 'pyq_practice' as const, practice_kind: 'regular', practice_initial_question: initial };
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(payload)).length > 13500 && initial.question_text.length > 500)
    initial.question_text = initial.question_text.slice(0, -500);
  return payload;
}
