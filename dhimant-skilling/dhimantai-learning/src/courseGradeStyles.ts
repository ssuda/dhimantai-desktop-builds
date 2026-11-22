export const GRADE_DETAIL_STYLES = `
.grade-detail {
  --sheet:var(--vscode-editor-background); --ink:var(--vscode-foreground);
  --line:var(--vscode-contrastBorder,color-mix(in srgb,var(--ink) 17%,var(--sheet)));
  --accent:#6242b5; --lit:40%; --warning:#80530b;
  padding:0; line-height:1.45; background:color-mix(in srgb,var(--sheet) 96%,var(--ink)); font-size:max(14px,var(--vscode-font-size,13px));
}
.grade-detail:is(.vscode-dark,.vscode-high-contrast) {--accent:#bba1ff;--lit:76%;--warning:#ffd382}
.grade-detail * {box-sizing:border-box}
.grade-detail h1,.grade-detail h2,.grade-detail h3,.grade-detail p {margin:0}
.grade-detail h1 {font-size:clamp(24px,3vw,36px);line-height:1.16;letter-spacing:-.025em;font-weight:650}
.grade-detail h2 {font-size:1.35em;line-height:1.3}.grade-detail h3 {font-size:1.05em}
.grade-detail p {margin-block:7px}.grade-detail small {color:var(--dh-muted)}
.grade-detail #notice {padding:10px clamp(16px,3vw,40px);margin:0}
.grade-detail #notice:empty {display:none}
.grade-detail main,.grade-detail .course-hero {padding:22px clamp(16px,3.5vw,52px);max-width:1560px;margin:auto}
.grade-detail .course-hero {display:block;padding-bottom:0;border-bottom:1px solid var(--line);background:
  radial-gradient(ellipse at top right,color-mix(in srgb,var(--accent) 14%,transparent),transparent 55%),
  color-mix(in srgb,var(--accent) 7%,var(--sheet))}
.grade-detail .crumb,.grade-detail .stack,.grade-detail .tabbar,.grade-detail [role=tablist],.grade-detail .hero-content,.grade-detail .ring-stat {display:flex;align-items:center;gap:10px}
.grade-detail .crumb {font-size:.88em;color:var(--dh-muted);margin-bottom:16px}
.grade-detail .crumb button {padding:0;color:var(--accent);background:transparent;min-height:24px}
.grade-detail .course-mark,.grade-detail .step-icon,.grade-detail .seal {display:grid;place-items:center;flex:none}
.grade-detail .course-mark {width:62px;height:62px;border-radius:16px;background:var(--accent);color:var(--sheet)}
.grade-detail .certificate-icon {width:1.25em;height:1.25em;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.grade-detail .course-mark svg {width:32px;height:32px}
.grade-detail .hero-content {gap:16px;flex-wrap:wrap}
.grade-detail .stack {flex-wrap:wrap;gap:5px}
.grade-detail .stack span,.grade-detail .lock-label,.grade-detail .requirements small {border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:.81em;background:var(--sheet)}
.grade-detail .readiness {margin-inline-start:auto;border:1px solid var(--line);border-radius:14px;background:var(--sheet);padding:12px 16px}
.grade-detail .ring {width:48px;height:48px;position:relative;display:inline-grid;place-items:center;flex:none;color:var(--accent)}
.grade-detail .ring svg {position:absolute;inset:0;transform:rotate(-90deg)}
.grade-detail .ring circle {fill:none;stroke-width:4}.grade-detail .ring .track {stroke:color-mix(in srgb,var(--accent) 14%,var(--sheet))}
.grade-detail .ring .fill {stroke:currentColor}.grade-detail .ring b {font-size:12px;color:var(--ink)}
.grade-detail .tabbar {margin-top:18px;justify-content:space-between;flex-wrap:wrap;gap:6px}
.grade-detail [role=tablist] {flex-wrap:wrap;gap:2px}
.grade-detail .tabbar button {padding:7px 12px;border-radius:7px 7px 0 0;border:1px solid transparent;background:transparent;color:var(--ink)}
.grade-detail .tabbar button[aria-selected=true] {border-color:var(--line);border-bottom:3px solid var(--accent);background:var(--sheet);color:var(--accent);font-weight:600}
.grade-detail .tabbar button[data-action=refresh] {font-size:.88em}
.grade-detail main section,.grade-detail .project-forms>*,.grade-detail .help-grid li,.grade-detail .milestone-grid li {border:1px solid var(--line);border-radius:12px;background:var(--sheet);margin:0;padding:16px;min-width:0;overflow-wrap:anywhere}
.grade-detail [role=tabpanel]>*+*,.grade-detail .grade-columns>div>*+* {margin-top:16px}
.grade-detail [role=tabpanel]>h2 {margin-bottom:10px}
.grade-detail [data-tone] {--tone:oklch(var(--lit) .13 var(--hue));--tint:color-mix(in srgb,var(--tone) 11%,var(--sheet))}
.grade-detail [data-tone="0"]{--hue:155}.grade-detail [data-tone="1"]{--hue:205}.grade-detail [data-tone="2"]{--hue:35}.grade-detail [data-tone="3"]{--hue:340}
.grade-detail [data-tone="4"]{--hue:65}.grade-detail [data-tone="5"]{--hue:280}.grade-detail [data-tone="6"]{--hue:46}.grade-detail [data-tone="7"]{--hue:83}
.grade-detail .journey ol,.grade-detail .milestone-grid,.grade-detail .help-grid {padding:0;list-style:none;display:grid;gap:12px}
.grade-detail .journey ol {grid-template-columns:repeat(auto-fit,minmax(80px,1fr));margin:16px 0}
.grade-detail .journey li {margin:0;position:relative;text-align:center;font-size:.9em}
.grade-detail .journey li:not(:last-child)::after {content:'';position:absolute;top:22px;left:calc(50% + 24px);width:calc(100% - 36px);border-top:2px dashed var(--line)}
.grade-detail .step-icon {width:44px;height:44px;margin:0 auto 7px;border:1px solid var(--tone);color:var(--tone);background:var(--tint);border-radius:12px}
.grade-detail .journey [aria-current=step] {font-weight:650}.grade-detail .journey [aria-current=step] .step-icon {background:var(--accent);color:var(--sheet);border-color:var(--accent)}
.grade-detail .next-step {display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;background:var(--accent);color:var(--sheet);padding:10px 14px;border-radius:8px}
.grade-detail .next-step span {margin-inline-start:8px}.grade-detail .next-step button {background:var(--sheet);color:var(--accent)}
.grade-detail button {font-size:inherit;min-height:32px}.grade-detail button:disabled {opacity:1;color:var(--dh-muted);background:var(--sheet);border:1px solid var(--line)}
.grade-detail .metrics,.grade-detail .grade-columns,.grade-detail .project-forms,.grade-detail .overview-extras {display:grid;gap:12px;align-items:start}
.grade-detail .metrics {grid-template-columns:repeat(auto-fit,minmax(min(100%,155px),1fr));align-items:stretch}
.grade-detail .metrics section {border-top:3px solid var(--accent);display:flex;gap:12px;align-items:center}
.grade-detail .metrics section:nth-child(2){border-top-color:var(--warning)}.grade-detail .metrics section:nth-child(3){border-top-color:#cb6241}
.grade-detail .metrics strong {font-size:1.2em}.grade-detail .metrics section>svg {color:var(--accent)}
.grade-detail .overview-extras {grid-template-columns:repeat(auto-fit,minmax(min(245px,100%),1fr))}
.grade-detail .course-attention {border:1px solid color-mix(in srgb,var(--warning) 50%,var(--sheet));background:color-mix(in srgb,var(--warning) 11%,var(--sheet));color:var(--warning);border-radius:10px;padding:12px 15px}
.grade-detail .attention-title,.grade-detail .grading-guide h2,.grade-detail .lock-label,.grade-detail .help-note {display:flex;align-items:center;gap:7px}
.grade-detail .course-attention ul,.grade-detail .grading-guide ul {margin:6px 0;padding-left:20px}
.grade-detail .weekly {background:color-mix(in srgb,#347bd4 7%,var(--sheet))}.grade-detail .recommend {background:color-mix(in srgb,#159768 8%,var(--sheet))}
.grade-detail .outline {padding:0 6px}
.grade-detail .milestone-grid {grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr))}
.grade-detail .milestone-grid li {padding:0;overflow:hidden}
.grade-detail .milestone-top {position:relative;display:grid;place-items:center;background:var(--tint);color:var(--tone);height:82px}
.grade-detail .milestone-top span {position:absolute;top:7px;left:9px;font-weight:600;font-size:.75em}
.grade-detail .milestone-top svg {width:26px;height:26px}.grade-detail .milestone-body {padding:12px}
.grade-detail .lock-label {width:fit-content}
.grade-detail .grade-columns,.grade-detail .project-forms {grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr))}
.grade-detail .project-forms>* {background:color-mix(in srgb,var(--accent) 5%,var(--sheet))}
.grade-detail .activity-count {display:flex;align-items:center;gap:8px}.grade-detail .activity-progress,.grade-detail .ring-stat {margin-block:12px}
.grade-detail .activity-progress progress {margin-top:6px}.grade-detail .criteria li {padding-bottom:7px;border-bottom:1px solid var(--line)}
.grade-detail .empty-state {border:1px dashed var(--line);border-radius:7px;padding:14px;color:var(--dh-muted)}
.grade-detail .credential-preview {position:relative;min-height:265px;display:grid;place-items:center;text-align:center;overflow:hidden;background:color-mix(in srgb,#b48a31 6%,var(--sheet));border:1px solid #b99a55;outline:1px solid #bb9f5c;outline-offset:-8px}
.grade-detail .paper {position:absolute;inset:17px;display:flex;flex-direction:column;align-items:center;justify-content:space-evenly;color:#967434;pointer-events:none}
.grade-detail .paper h3 {font-family:Georgia,serif;font-size:1.8em}.grade-detail .paper svg {width:50px;height:50px}
.grade-detail .locked .paper {filter:blur(4px);opacity:.64}
.grade-detail .preview-status {z-index:1;max-width:85%;padding:10px;background:color-mix(in srgb,var(--sheet) 88%,transparent);border-radius:14px}
.grade-detail .seal {margin:0 auto 8px;width:46px;height:46px;border-radius:50%;background:#44351f;color:white;outline:4px solid #b99a5555}
.grade-detail button:disabled svg {width:1em;height:1em;vertical-align:-.15em;margin-right:5px}
.grade-detail .earned-paper {background:color-mix(in srgb,#c19542 7%,var(--sheet));border:3px double #b99a55;border-radius:6px;padding:24px;text-align:center;margin-bottom:16px}
.grade-detail .earned-paper svg {display:block;width:38px;height:38px;margin:10px auto;color:var(--warning)}
.grade-detail .earned-paper h3 {font:1.6em/1.2 Georgia,serif;margin:8px}.grade-detail .earned-paper strong {font-size:1.25em}
.grade-detail .requirement-reason {display:block;font-size:.88em;color:var(--dh-muted)}
.grade-detail .requirements {list-style:none;padding:0}.grade-detail .requirements li {display:flex;align-items:center;gap:7px;border-bottom:1px solid var(--line);padding-bottom:6px}.grade-detail .requirements small {margin-left:auto}
.grade-detail .help-grid {grid-template-columns:repeat(3,minmax(0,1fr))}
.grade-detail .help-grid li {margin:0;border-top:3px solid var(--tone)}.grade-detail .help-grid h3 span {margin-right:10px;background:var(--tint);color:var(--tone);border-radius:5px;padding:2px 7px}
.grade-detail .help-note {padding:12px;background:var(--sheet);border-radius:8px}
@media(max-width:700px){.grade-detail .help-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.grade-detail .journey li::after{display:none}.grade-detail .readiness{margin-inline-start:0}}
@media(max-width:460px){.grade-detail .course-mark{width:38px;height:38px}.grade-detail .hero-content{gap:8px}.grade-detail .tabbar button{padding:6px}.grade-detail .help-grid{grid-template-columns:1fr}}
`;
