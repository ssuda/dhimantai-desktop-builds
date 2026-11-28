export interface LearningPreferences {
  preferred_name: string;
  doubt_style: 'adaptive' | 'guided' | 'direct';
  check_frequency: 'frequent' | 'occasional' | 'minimal';
  voice: '' | 'warm' | 'energetic' | 'calm';
  learning_goal: string;
  current_role: string;
  experience: '' | 'new' | 'some' | 'professional';
}
const line = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
/** The learner's goal, role and experience, sent only once any is set so older services keep working. */
export function learnerProfile(p: LearningPreferences): Partial<LearningPreferences> {
  return p.learning_goal || p.current_role || p.experience
    ? {learning_goal:p.learning_goal, current_role:p.current_role, experience:p.experience} : {};
}
export const hasEmail = (p: LearningPreferences) => [p.preferred_name, p.learning_goal, p.current_role].some(text => /@|[\r\n]/.test(text));
export function learningPreferences(value: unknown): LearningPreferences {
  const p = value as Partial<LearningPreferences> | undefined;
  return {
    doubt_style: p?.doubt_style === 'guided' || p?.doubt_style === 'direct' ? p.doubt_style : 'adaptive',
    preferred_name: typeof p?.preferred_name === 'string' ? p.preferred_name.trim().slice(0, 60) : '',
    check_frequency: p?.check_frequency === 'occasional' || p?.check_frequency === 'minimal' ? p.check_frequency : 'frequent',
    voice: p?.voice === 'warm' || p?.voice === 'energetic' || p?.voice === 'calm' ? p.voice : '',
    learning_goal: line(p?.learning_goal, 200),
    current_role: line(p?.current_role, 80),
    experience: p?.experience === 'new' || p?.experience === 'some' || p?.experience === 'professional' ? p.experience : '',
  };
}

export const learningPreferencesHtml = `<fieldset id="learning-preferences"><legend>Learning preferences</legend>
<label>Preferred name <input id="preferred-name" maxlength="60" autocomplete="given-name" placeholder="Name to use in greetings"></label>
<label>What do you want to use this for? <input id="learning-goal" maxlength="200" placeholder="For example: automate reports at work, move into data analysis"></label>
<label>Your current role <input id="current-role" maxlength="80" autocomplete="organization-title" placeholder="For example: accountant, student, support engineer"></label>
<label>Experience with this subject <select id="learning-experience"><option value="">Not set</option><option value="new">New to it</option><option value="some">Learned or used some</option><option value="professional">I use it at work</option></select></label>
<small>Instructor uses these to pick examples and explain why each idea matters to you.</small>
<label>Understanding checks <select id="check-frequency"><option value="frequent">Frequent</option><option value="occasional">After major concepts</option><option value="minimal">Fewer interruptions</option></select></label>
<small>Required course assessments still apply.</small>
<label id="doubt-style-setting" hidden>Default for new doubts <select id="doubt-style"><option value="adaptive">Adaptive</option><option value="guided">Guided — let me try</option><option value="direct">Direct — explain the answer</option></select></label>
<label>Voice <select id="preferred-voice"><option value="">Account default</option><option value="warm">Warm (Female)</option><option value="energetic">Energetic (Male)</option><option value="calm">Calm (Male)</option></select></label>
<small id="learning-preferences-status" role="status">Saved for this account on this computer. Voice changes apply to the next spoken reply.</small></fieldset>`;
