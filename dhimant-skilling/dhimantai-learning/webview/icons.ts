/** Small, theme-colored controls; the enclosing button supplies the accessible name. */
export function icon(paths: string) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
export const expandIcon = icon('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>');
export const collapseIcon = icon('<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>');
