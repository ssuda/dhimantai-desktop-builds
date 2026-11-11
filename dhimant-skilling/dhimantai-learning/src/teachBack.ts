/** Optional prompts in the existing conversation; these do not award progress. */
export const teachBackInvitation = 'Explain your approach, a bug fix, or a concept in your own words. Include one example and why it works. I’ll check your reasoning and ask one follow-up. You can skip this and keep coding.';

export function teachBackRequest(explanation: string): string {
  return 'Check my teach-back below against the current exercise, code and any current run evidence. '
    + 'Briefly name what I got right, address one misconception or missing reason, and ask one focused follow-up. '
    + 'If my explanation is sound, offer one small variation for me to solve independently without revealing its answer. '
    + 'Do not replace my explanation with a full solution or treat it as proof of independent mastery. '
    + 'Do not claim code ran or a fix worked without current execution evidence.\n\nMy explanation:\n' + explanation;
}

export const topicTeachBackRequest = 'I’d like to teach back the topic we are discussing in my own words. '
  + 'Ask me one short question about it and wait for my explanation. Then check what I got right, '
  + 'help with one gap, and ask one follow-up. Once my explanation is sound, offer a small variation '
  + 'for me to try independently. Keep this in our conversation; an explanation alone does not show mastery.';
