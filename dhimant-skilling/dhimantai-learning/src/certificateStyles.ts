export const CERTIFICATE_STYLES = `
.certificate-library {
  --card-border: var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 18%, var(--vscode-editor-background)));
  --course-lightness: 45%;
  --on-course: white;
  --warning-ink: #704407;
  --warning-fill: #fff4de;
  --warning-border: #e5bd70;
  --surface: var(--vscode-editor-background);
  box-sizing: border-box;
  max-width: 1520px;
  margin-inline: auto;
  background: color-mix(in srgb, var(--surface) 96%, var(--vscode-foreground));
  font-size: max(14px, var(--vscode-font-size, 13px));
  line-height: 1.45;
}
.certificate-library.vscode-dark, .certificate-library.vscode-high-contrast:not(.vscode-high-contrast-light) {
  --course-lightness: 78%;
  --on-course: #16151b;
  --warning-ink: #ffda94;
  --warning-fill: #352b1b;
  --warning-border: #8e723d;
}
.certificate-library header { align-items: flex-start; }
.certificate-library h1 { font-size: 2em; font-weight: 650; line-height: 1.2; margin: 0; }
.certificate-library header p { margin: 4px 0 0; }
.certificate-library button { min-height: 32px; font-size: .94em; line-height: 1.35; }
.certificate-library button:hover:enabled { filter: brightness(.93); }
.certificate-library button[data-action=refresh], .certificate-filters button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--surface); color: var(--vscode-foreground); border: 1px solid var(--card-border);
}
.certificate-library button[data-action=refresh] { min-height: 28px; padding: 4px 10px; font-size: .86em; }
.certificate-library #notice:empty { display: none; }
.certificate-icon { width: 1.1em; height: 1.1em; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.certificate-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 16px; }
.certificate-filters button { border-radius: 999px; padding: 5px 13px; }
.certificate-filters button[data-filter=unavailable] { color: var(--warning-ink); background: var(--warning-fill); border-color: var(--warning-border); }
.certificate-filters button[aria-pressed=true] { background: var(--vscode-foreground); color: var(--surface); border-color: var(--vscode-foreground); }
.certificate-library section { box-sizing: border-box; margin: 0; padding: 18px; background: var(--surface); border: 1px solid var(--card-border); border-radius: 12px; }
.certificate-library h2 { font-size: 1.16em; margin: 0; line-height: 1.3; }
.certificate-intro { display: grid; gap: 14px; margin-bottom: 18px; }
.certificate-intro:has(.certificate-guidance) { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
.certificate-intro h2, .attention-title { display: flex; gap: 8px; align-items: center; }
.certificate-guidance h2 svg { color: var(--warning-ink); }
.grading-guide h2 svg { color: var(--vscode-textLink-foreground); }
.certificate-guidance ol { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 0; margin: 16px 0; list-style: none; counter-reset: step; }
.certificate-guidance li { position: relative; padding-inline-start: 34px; margin: 0; counter-increment: step; }
.certificate-guidance li::before {
  content: counter(step); position: absolute; inset: 0 auto auto 0; display: grid; place-items: center;
  width: 24px; height: 24px; border-radius: 50%; background: var(--warning-fill); color: var(--warning-ink); border: 1px solid var(--warning-border);
}
.certificate-guidance li span { display: block; color: var(--dh-muted); margin-top: 3px; font-size: .94em; }
.guidance-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.guidance-actions p { color: var(--dh-muted); font-size: .92em; flex: 1 1 220px; margin: 0; }
.guidance-actions button { background: #925207; color: white; }
.grading-guide ul { padding-inline-start: 20px; margin: 10px 0 0; }
.grading-guide li { margin: 4px 0; }
.eligibility-notice { padding: 10px 14px; border-inline-start: 3px solid var(--dh-success); }
.certificate-library .certificate-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.certificate-library .certificate-course {
  display: flex; flex-direction: column; align-items: flex-start; gap: 14px; min-width: 0;
  --course-color: oklch(var(--course-lightness) .15 var(--course-hue));
  border-top: 5px solid var(--course-color); overflow-wrap: anywhere;
}
.certificate-course .dh-chip {
  background: color-mix(in srgb, var(--course-color) 10%, var(--surface));
  color: color-mix(in srgb, var(--course-color) 40%, var(--vscode-foreground));
  border-color: color-mix(in srgb, var(--course-color) 32%, var(--surface));
}
.certificate-course h2 { font-size: 1.24em; }
.certificate-course p { margin: 0; }
.activity-progress, .course-attention { align-self: stretch; }
.activity-count { display: flex; align-items: center; gap: 10px; }
.activity-count strong, .activity-count small { display: block; }
.activity-count strong { font-size: 1.25em; }
.activity-count small { color: var(--dh-muted); font-size: .94em; }
.activity-count .icon-tile {
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 9px; flex: none;
  color: color-mix(in srgb, var(--course-color) 50%, var(--vscode-foreground));
  background: color-mix(in srgb, var(--course-color) 11%, var(--surface));
}
.activity-progress .dh-progress { --vscode-progressBar-background: var(--course-color); margin-top: 12px; height: 5px; }
.course-attention { border: 1px solid var(--warning-border); border-radius: 8px; background: var(--warning-fill); color: var(--warning-ink); padding: 10px 12px; font-size: .94em; }
.course-attention ul { margin: 5px 0 0; padding-inline-start: 18px; }
.course-attention li { margin: 3px 0; }
.course-attention li:only-child { list-style: none; }
.course-attention ul:has(li:only-child) { padding: 0; }
.certificate-course .actions { margin-top: auto; }
.certificate-course button { background: var(--course-color); color: var(--on-course); }
.certificate-course button[data-action=catalog] { background: var(--surface); color: var(--vscode-foreground); border: 1px solid var(--card-border); }
.certificate-library:is(.vscode-high-contrast,.vscode-high-contrast-light) button { border: 1px solid currentColor; }
@media (max-width: 1099px) { .certificate-library .certificate-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 840px) {
  .certificate-intro:has(.certificate-guidance) { grid-template-columns: 1fr; }
  .certificate-library .certificate-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 540px) {
  .certificate-library .certificate-grid, .certificate-guidance ol { grid-template-columns: 1fr; }
  .certificate-guidance li { min-height: 26px; }
}
`;
