export interface LearningPreferences {
  preferred_name: string;
  check_frequency: 'frequent' | 'occasional' | 'minimal';
  voice: '' | 'warm' | 'energetic' | 'calm';
}
export function learningPreferences(value: unknown): LearningPreferences {
  const p = value as Partial<LearningPreferences> | undefined;
  return {
    preferred_name: typeof p?.preferred_name === 'string' ? p.preferred_name.trim().slice(0, 60) : '',
    check_frequency: p?.check_frequency === 'occasional' || p?.check_frequency === 'minimal' ? p.check_frequency : 'frequent',
    voice: p?.voice === 'warm' || p?.voice === 'energetic' || p?.voice === 'calm' ? p.voice : '',
  };
}

export const learningPreferencesHtml = `<fieldset id="learning-preferences"><legend>Learning preferences</legend>
<label>Preferred name <input id="preferred-name" maxlength="60" autocomplete="given-name" placeholder="Name to use in greetings"></label>
<label>Understanding checks <select id="check-frequency"><option value="frequent">Frequent</option><option value="occasional">After major concepts</option><option value="minimal">Fewer interruptions</option></select></label>
<small>Required course assessments still apply.</small>
<label>Voice <select id="preferred-voice"><option value="">Account preference</option><option value="warm">Warm</option><option value="energetic">Energetic</option><option value="calm">Calm</option></select></label>
<small id="learning-preferences-status" role="status">Saved for this account on this computer. Voice changes apply to the next spoken reply.</small></fieldset>`;
