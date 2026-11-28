import type { CatalogCourse } from './learnerCatalog';

export const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const styles = {
  ai: {hue:285, icon:'M6 7a2.5 2.5 0 1 0 0 .1M6 19a2.5 2.5 0 1 0 0 .1M21 13a2.5 2.5 0 1 0 0 .1M8 7.5l8 4M8 17.5l8-4'},
  professional: {hue:70, icon:'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM4 20a8 8 0 0 1 16 0'},
  engineering: {hue:255, icon:'M7 7l-5 5 5 5m10-10 5 5-5 5m-3-14-4 18'},
  essentials: {hue:182, icon:'M3 4h18v16H3ZM6 9l3 3-3 3m6 0h5'},
  campus: {hue:349, icon:'M2 9l10-5 10 5-10 5ZM6 11v6l6 3 6-3v-6m4-2v7'},
  workplace: {hue:264, icon:'M3 8h18v12H3ZM8 8V5h8v3M3 12q9 4 18 0m-10 1h2'},
  business: {hue:195, icon:'M3 20V8l9-5 9 5v12ZM9 20v-7h6v7M8 9h1m6 0h1'},
  projects: {hue:34, icon:'M4 20l4-1 12-12-3-3L5 16ZM14 7l3 3'},
  bundles: {hue:272, icon:'M3 7l9-5 9 5v10l-9 5-9-5ZM3 7l9 5 9-5m-9 5v10'},
  other: {hue:225, icon:'M3 4q5-1 9 2 4-3 9-2v14q-5-1-9 2-4-3-9-2ZM12 6v14'},
};
type Style = keyof typeof styles;
const categories = new Map<string, Style>([
  ['AI & Machine Learning', 'ai'], ['AI for Professionals', 'professional'], ['Software Engineering', 'engineering'],
  ['Engineering Essentials', 'essentials'], ['Campus Recruitment Training', 'campus'], ['Workplace Skills', 'workplace'],
  ['Business applications', 'business'],
]);

export const categoryOf = (course: CatalogCourse) => course.category || 'Software Engineering';
export const sectionOf = (course: CatalogCourse) => course.id === 'erpnext-essentials' ? 'Business applications'
  : course.id.startsWith('engineering-') ? 'Engineering Essentials' : categoryOf(course);
export const styleOf = (title: string): Style => categories.get(title) ?? 'other';

export const typeColors = Object.entries(styles).map(([key, style]) => `[data-tone="${key}"]{--hue:${style.hue}}`).join('\n');

export function typeIcon(style: Style) {
  return `<svg class="type-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${styles[style].icon}"/></svg>`;
}

export interface CatalogSection {
  title: string;
  style: Style;
  content: string;
}

export function sectionChips(sections: CatalogSection[]) {
  return `<nav class="type-nav" aria-labelledby="browse-types"><h2 id="browse-types">Pick a path</h2><div class="type-list">${sections.map(section => {
    const category = section.style === 'projects' ? 'type:project' : section.style === 'bundles' ? 'type:bundle' : section.title;
    return `<button type="button" class="type-chip" data-tone="${section.style}" data-browse-category="${escape(category)}">${typeIcon(section.style)}${escape(section.title)}</button>`;
  }).join('')}</div></nav>`;
}
