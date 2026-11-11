/**
 * One visual language for every dhimantAI learning surface: Course Catalog,
 * Instructor and Doubt Solver notebooks, and Study. Each page inlines this in
 * its <head>, so all of them share spacing, shape, chips and progress bars.
 * It defines no palette: every colour is a variable of the app's active color
 * theme (Light Modern by default in the dhimantAI desktop), so a theme change or
 * high contrast restyles the learning panels with the rest of the app.
 */
export const UI_TOKENS = `:root{
  --dh-radius:8px;--dh-radius-sm:5px;--dh-radius-pill:999px;
  --dh-space-1:4px;--dh-space-2:8px;--dh-space-3:12px;--dh-space-4:16px;--dh-space-5:24px;--dh-space-6:32px;
  --dh-border:var(--vscode-panel-border,var(--vscode-widget-border));
  --dh-surface:var(--vscode-editorWidget-background,var(--vscode-editor-background));
  --dh-muted:var(--vscode-descriptionForeground);
  --dh-accent:var(--vscode-button-background);
  --dh-accent-fg:var(--vscode-button-foreground);
  --dh-success:var(--vscode-testing-iconPassed,var(--vscode-charts-green));
  --dh-shadow:0 1px 4px var(--vscode-widget-shadow,transparent);
}
.dh-eyebrow{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dh-muted)}
.dh-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:var(--dh-radius-pill);font-size:11px;line-height:18px;font-weight:600;
  border:1px solid var(--dh-border);color:var(--vscode-foreground);white-space:nowrap}
.dh-chip.accent{border-color:transparent;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.dh-chip.success{border-color:var(--dh-success);color:var(--dh-success)}
.dh-progress{display:block;width:100%;height:6px;border:0;border-radius:var(--dh-radius-pill);overflow:hidden;appearance:none;
  background:color-mix(in srgb,var(--vscode-foreground) 12%,transparent);color:var(--vscode-progressBar-background,var(--dh-accent))}
.dh-progress::-webkit-progress-bar{background:transparent}
.dh-progress::-webkit-progress-value{background:var(--vscode-progressBar-background,var(--dh-accent));border-radius:var(--dh-radius-pill)}
.dh-progress::-moz-progress-bar{background:var(--vscode-progressBar-background,var(--dh-accent))}
.dh-card{border:1px solid var(--dh-border);border-radius:var(--dh-radius);background:var(--dh-surface);box-shadow:var(--dh-shadow)}
.dh-select{font:inherit;padding:6px 8px;border-radius:var(--dh-radius-sm);color:var(--vscode-dropdown-foreground,var(--vscode-input-foreground));
  background:var(--vscode-dropdown-background,var(--vscode-input-background));border:1px solid var(--vscode-dropdown-border,var(--dh-border))}
@media (forced-colors:active){.dh-progress{border:1px solid CanvasText}.dh-card{box-shadow:none}}`;

/** Chapter-coverage bar; a native <progress> needs no inline style, so it works under strict CSPs. */
export function progressBar(covered: number, total: number, label: string): string {
  const safe = label.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  return `<progress class="dh-progress" max="${Math.max(total, 1)}" value="${Math.min(covered, total)}" aria-label="${safe}"></progress>`;
}
