/** Coaching language is independent of the programming language in a code cell. */
export const coachingLanguages: Record<string, string> = {
  'en-IN':'English', 'hi-IN':'हिन्दी', 'te-IN':'తెలుగు', 'ta-IN':'தமிழ்',
  'kn-IN':'ಕನ್ನಡ', 'ml-IN':'മലയാളം', 'mr-IN':'मराठी', 'bn-IN':'বাংলা',
  'gu-IN':'ગુજરાતી', 'pa-IN':'ਪੰਜਾਬੀ', 'ur-IN':'اردو',
};
export const coachingLanguage = (value: unknown): string =>
  typeof value === 'string' && Object.hasOwn(coachingLanguages, value) ? value : 'en-IN';

export const mentorLanguageControl = `<label class="voice-setting">Spoken language <select id="voiceLanguage">
<option value="auto">Follow spoken language</option>${Object.entries(coachingLanguages).map(([id,label]) => `<option value="${id}">${label}</option>`).join('')}
</select></label>`;
