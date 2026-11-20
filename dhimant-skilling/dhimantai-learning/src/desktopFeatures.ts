// Temporarily paused until desktop course selection and reading materials are ready.
export const STUDY_ENABLED = false;

// The standalone Shelf and Rich reading projects are deferred beyond Phase 1.
export const CODE_READING_PROJECTS_ENABLED = false;

export function desktopProjectEnabled(id: string) {
  return CODE_READING_PROJECTS_ENABLED || (id !== 'shelf-reading' && id !== 'rich-reading');
}

export const CODE_READING_PAUSED = 'Code-reading projects are paused on desktop. You can still open your saved files in Explorer.';
