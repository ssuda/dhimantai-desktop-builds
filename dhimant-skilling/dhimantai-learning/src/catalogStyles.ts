/** Shared course colour treatments adapt to the active editor theme. */
export const categoryCardStyles = `
[data-category-card]{
  --accent:oklch(65% .21 var(--hue,260));
  --tint:color-mix(in oklab,var(--accent) 23%,var(--paper));
  background:var(--tint);border-color:color-mix(in oklab,var(--accent) 52%,var(--paper));
  border-block-start:4px solid var(--accent)
}
body.vscode-dark [data-category-card]{--accent:oklch(76% .18 var(--hue,260));--tint:color-mix(in oklab,oklch(58% .26 var(--hue,260)) 43%,var(--paper))}
body:is(.vscode-high-contrast,.vscode-high-contrast-light) [data-category-card]{--accent:var(--vscode-contrastBorder);--tint:var(--paper)}
`;

/** Catalog surfaces inherit the host theme. */
export const catalogStyles = `
*{box-sizing:border-box}
body{
  --hue:255;--tag-lightness:37%;--paper:var(--vscode-editorWidget-background,var(--vscode-editor-background));
  --canvas:color-mix(in srgb,var(--vscode-editor-background) 95%,#8a77be);
  --line:var(--vscode-panel-border,color-mix(in srgb,var(--vscode-foreground) 17%,var(--paper)));
  --primary:#4f3fd8;--on-primary:#fff;--hero:#211d32;--hero-text:#faf8ff;--warm:#ffb82e;--on-warm:#261900;
  font: max(15px,var(--vscode-font-size,13px))/1.5 var(--vscode-font-family,system-ui);
  color:var(--vscode-foreground);background:var(--canvas);
  max-width:1440px;margin:auto;padding:clamp(12px,3vw,44px);overflow-wrap:anywhere
}
@media(max-width:1100px){.catalog-bar{grid-template-columns:minmax(0,1fr) auto}.top>.actions{grid-column:2}.catalog-bar .catalog-nav{grid-row:2;grid-column:1/-1}}
body.vscode-dark{--tag-lightness:83%;--primary:#b9aeff;--on-primary:#201639;--hero:#262036}
.track-tag,.type-chip,.suggestions button{
  --ink:oklch(var(--tag-lightness) .10 var(--hue));--wash:color-mix(in srgb,var(--ink) 9%,var(--paper));--edge:color-mix(in srgb,var(--ink) 24%,var(--paper))
}
h1,h2,h3,p{margin:0}
h1{font-size:clamp(25px,2.5vw,35px);letter-spacing:-.035em;line-height:1.2}
h2{font-size:20px;letter-spacing:-.02em;margin:24px 0 10px;line-height:1.25}
h3{font-size:17px;letter-spacing:-.015em;line-height:1.3}
p+p{margin-top:6px}
.muted,.small,.period{color:var(--dh-muted)}.small,.period{font-size:.9em}
.catalog-bar{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;
  gap:8px 18px;padding:8px 0;background:var(--canvas);border-bottom:1px solid var(--line)}
.top{display:contents}.top h1{font-size:clamp(18px,2vw,24px)}.top>.actions{grid-column:3;grid-row:1;justify-content:flex-end}
.top>.actions>span{max-width:22ch;overflow-wrap:anywhere}
.actions,.meta,.paths,.type-list{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
button,input,select{font:inherit}
button{cursor:pointer;border:1px solid var(--dh-button-border);border-radius:6px;padding:6px 12px;line-height:1.35;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:hover{filter:brightness(.94)}
button.secondary{background:var(--paper);color:var(--vscode-foreground);border-color:var(--line)}
button:disabled{opacity:.6;cursor:default}
:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}
[hidden]{display:none!important}
input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--line));
  border-radius:6px;padding:7px 9px;min-width:0;width:100%}
label{font-size:.92em}
.home-feature,.home-other,.home-grid,.suggestions,#results{display:grid;gap:14px;min-width:0}
.home-feature:has(.home-other){grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}
.home-other{align-content:start}.home-feature{max-width:100%}
.home-choices{display:grid;gap:14px;min-width:0;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.home-choices+.home-other{margin-top:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))}
.home-choices .resume-card.first h3{font-size:clamp(22px,2.4vw,32px)}.home-choices .actions{margin-top:auto;padding-top:8px}
.resume-card .dh-eyebrow{margin:0}
.home-grid,.suggestions{grid-template-columns:repeat(auto-fill,minmax(min(100%,max(210px,calc((100% - 42px)/4))),1fr))}
.resume-card,.home-tile,.course,.suggestions button{min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:16px}
.resume-card,.home-tile{display:flex;align-items:flex-start;flex-direction:column;gap:9px;padding:clamp(15px,2vw,24px)}
.resume-card.first{background:var(--hero);color:var(--hero-text);border-color:transparent;padding:clamp(24px,3.3vw,46px)}
.resume-card.first h3{font-size:clamp(25px,3vw,39px);letter-spacing:-.04em;max-width:34ch}
.resume-card.first p{max-width:72ch}.resume-card.first :is(.meta,.small){color:inherit}
.resume-card .next{margin:7px 0}.home-feature .actions,.home-tile .actions{margin-top:auto;padding-top:8px}
.home-access{font-size:.86em}.home-feature .dh-progress{height:6px;margin:5px 0}
.resume-card.first .dh-progress{background:color-mix(in srgb,var(--hero-text) 22%,transparent)}
.resume-card.first .dh-progress::-webkit-progress-value{background:var(--warm)}
.home-tile p{color:var(--dh-muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.shelf-heading,.result-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.shelf-heading h2{margin:0}.shelf-heading{margin-bottom:12px}
#catalog-home>section,#catalog-home>.type-nav{margin-block:clamp(22px,3vw,38px)}
.view-title{font-size:clamp(32px,4vw,48px);letter-spacing:-.045em;margin-block:clamp(24px,4vw,48px) 18px}
.track-tag{display:inline-flex;align-items:center;background:var(--wash);color:var(--ink);border:1px solid var(--edge);font-size:12px;line-height:1.35;border-radius:99px;padding:3px 8px;font-weight:600}
.notice{margin:14px 0;padding:12px 14px;background:var(--paper);border:1px solid var(--line);border-radius:8px}
#status{font-size:.93em;color:var(--dh-muted)}#status:has(#status-message:empty):has(#payment-check[hidden]){display:none}
#status:not(:empty){margin-top:10px}
.suggestions button{display:flex;align-items:center;gap:10px;text-align:start;padding:10px 12px;font-weight:600}
.suggestions small{display:block;font-weight:400;color:var(--dh-muted)}.suggestions .type-icon{color:var(--ink)}
.type-list{gap:7px}.type-chip,.paths button{border-radius:99px;font-size:.91em}
.type-chip{display:inline-flex;align-items:center;gap:6px;color:var(--ink);background:var(--wash);border-color:var(--edge)}
.type-icon{width:17px;height:17px;flex:none}
.explore-search{margin:0 0 18px}.explore-search input{display:block;margin-top:5px;min-height:44px;border-radius:10px}
.explore-layout{display:grid;grid-template-columns:minmax(175px,220px) minmax(0,1fr);gap:clamp(12px,2vw,28px);align-items:start}
.discovery-filters{display:grid;gap:16px;padding:17px;background:var(--paper);border:1px solid var(--line);border-radius:16px}
.discovery-filters select{display:block;margin-top:4px}
#toggle-filters{display:none}.result-tools label{display:flex;align-items:center;gap:8px}.result-tools select{width:auto}
#result-count{color:var(--dh-muted);font-size:.95em}.result-tools{margin-bottom:12px}
#active-filters{display:flex;flex-wrap:wrap;gap:6px}#active-filters:not(:empty){margin-bottom:14px}
#active-filters button,.paths button{border-radius:99px;font-size:.88em}
.paths button[aria-pressed=true]{background:var(--primary);color:var(--on-primary)}
#results{gap:28px}
.category-grid,#results.flat{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,max(198px,calc((100% - 24px)/3))),1fr))}
.result-group .track-tag{display:none}
.result-group .shelf-heading{justify-content:flex-start}.group-count{color:var(--dh-muted)}
.group-more{display:block;margin:12px auto 0}.sr-only,.chips input{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.filter-options{min-width:0;border:0;padding:0;margin:0}.filter-options legend{font-size:.9em;font-weight:600;margin-bottom:6px}
.filter-options label{display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer}.filter-options input{width:auto;margin:0;accent-color:var(--primary)}
.filter-options.chips label{position:relative;display:inline-flex;padding:0;margin:2px}.chips label span{border:1px solid var(--line);border-radius:99px;padding:5px 10px;background:var(--paper)}
.chips input:checked+span{color:var(--on-primary);background:var(--primary);border-color:var(--primary);font-weight:600}
.chips input:focus-visible+span{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
#catalog-explore>.chips{margin-bottom:18px}

.course{display:flex;flex-direction:column;padding:16px}
.course .card-body{min-width:0}.course h3{margin:7px 0 5px}.course p{font-size:.94em}.course .summary{color:var(--dh-muted)}
.course:not(:has(details[open])) .summary{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.meta{font-size:.8em;line-height:1.35;color:var(--dh-muted);gap:4px 8px}
.level,.access-tag,.size-tag,.save,.members li{display:inline-block;border-radius:4px;padding:2px 6px}
.level,.members li{background:color-mix(in srgb,var(--vscode-foreground) 6%,var(--paper))}
.joined{color:var(--vscode-foreground);margin-left:auto;font-weight:600}
.access-tag{color:var(--vscode-foreground);background:var(--dh-surface);border:1px solid var(--line);font-size:.8em;line-height:1.25;margin-top:7px}
.meta .access-tag{margin:0;font-size:1em}
.course .actions{justify-content:space-between;margin-top:auto;padding-top:12px;gap:6px}
.actions .period{font-size:.8em}
details{font-size:.93em;margin-top:7px}summary{cursor:pointer;color:var(--dh-muted);width:fit-content}
details[open]>summary{margin-bottom:7px}details p{margin:6px 0}li{margin:3px 0}ol,ul{padding-left:20px}
.coverage{margin:8px 0}.coverage p{font-size:.8em;color:var(--dh-muted);margin-top:3px}.covered>span{color:var(--dh-success)}
.project>p{margin:4px 0}.size-tag,.save{background:var(--dh-surface);color:var(--vscode-foreground);font-weight:600}
.size-tag{text-transform:uppercase;letter-spacing:.055em}.project-status{margin-inline-start:auto;color:var(--dh-muted)}
[data-project=course-projects]{margin-bottom:12px}.setup-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px}
.setup-controls select{width:auto;flex:1 1 14em}.setup-controls .actions{padding:0;margin:0}
.offer{padding:0;border:1px solid var(--line);overflow:hidden}.offer-head,.offer-body{padding:12px 15px}
.offer-head{background:var(--canvas)}.offer-head h3{margin:0 0 6px}.offer-head p{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.price{font-size:1.65em;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.035em}.save{font-size:.82em}
.offer-body{display:flex;flex-direction:column;flex:1;align-items:flex-start}.members{display:flex;flex-wrap:wrap;gap:4px;list-style:none;margin:0;padding:0}
.members li{font-size:.85em;margin:0}.offer-body .actions{padding-top:12px}
#empty,footer{margin:14px 0;font-size:.93em}
.catalog-nav{grid-column:2;grid-row:1;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.catalog-nav>button{font-size:.94em}.catalog-nav>button.secondary{border-color:transparent}
.catalog-nav>button.secondary:hover{background:var(--dh-surface);border-color:var(--line)}
#open-guide{display:inline-flex;align-items:center;gap:7px;margin-inline-start:auto;font-weight:600}
.access-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:16px 0 0;padding:12px 4px;
  border:1px solid var(--line);border-radius:8px;background:var(--paper)}
.access-facts div{padding:0 clamp(10px,2vw,24px)}.access-facts div+div{border-inline-start:1px solid var(--line)}
.access-facts dt,.requirements dt{font-weight:650}.access-facts dd,.requirements dd{margin:2px 0 0;color:var(--dh-muted)}
.access-facts dd{font-size:.92em}
#course-guide{width:min(780px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;
  padding:0;color:var(--vscode-foreground);background:var(--paper);border:1px solid var(--line);border-radius:10px;box-shadow:var(--dh-shadow)}
#course-guide::backdrop{background:rgb(0 0 0 / .52)}
.guide-heading{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line)}
.guide-heading>.type-icon{width:23px;height:23px;color:var(--vscode-textLink-foreground)}
.guide-heading h2{margin:0}.guide-heading form{margin-inline-start:auto}
.guide-body{display:grid;min-height:265px;grid-template-columns:minmax(155px,27%) 1fr}
.guide-topics{display:flex;flex-direction:column;gap:4px;padding:14px 8px;background:var(--dh-surface);border-inline-end:1px solid var(--line)}
.guide-topics button{display:flex;align-items:center;gap:9px;padding:9px;text-align:start;color:var(--vscode-foreground);
  background:transparent;border:1px solid transparent}
.guide-topics button[aria-selected=true]{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground);
  border-color:var(--vscode-contrastActiveBorder,transparent);box-shadow:inset 3px 0 var(--vscode-focusBorder);font-weight:650}
.guide-topics button:not([aria-selected=true]):hover{background:var(--vscode-list-hoverBackground)}
.guide-body section{min-width:0;align-self:start;margin:6px;padding:clamp(10px,2vw,20px)}
.guide-body h3{font-size:20px;margin:0 0 10px}.guide-body h4{font-size:1em;margin:16px 0 4px}
.guide-body h3+h4{margin-top:0}.guide-body p+p,.guide-body p+button,.guide-body details+p{margin-top:10px}
.guide-body label{display:block;margin:12px 0 3px}.guide-body select{margin-bottom:6px}
.requirements{margin:0}.requirements div+div{margin-top:12px}
#course-guide footer{margin:0;padding:12px 18px;border-top:1px solid var(--line)}
#course-guide [data-action=support]{margin-inline-start:auto}
#guide-feedback:not(:empty),#guide-setup-status:not(:empty){margin-top:8px}
@media(max-width:540px){
  .guide-body{display:block;min-height:0}.guide-topics{flex-direction:row;flex-wrap:wrap;gap:4px;padding:8px;border-inline-end:0;border-bottom:1px solid var(--line)}
  .guide-topics button{padding:5px 7px;font-size:.92em}.guide-topics .type-icon{display:none}
  .guide-heading{padding:12px}.access-facts{grid-template-columns:1fr;gap:6px;padding:10px 12px}
  .access-facts div{padding:0;display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px}.access-facts div+div{border:0}
  .access-facts dd{margin:0}#course-guide [data-action=support]{margin-inline-start:0}
}
@media(max-width:390px){.catalog-nav{gap:2px}.catalog-nav>button{padding:5px 6px}#open-guide{margin-inline-start:0}#open-guide .type-icon{display:none}}
button{border-radius:9px}.view-link{background:transparent;color:var(--vscode-foreground);border-color:transparent}
.view-link[aria-current=page]{color:var(--primary);background:color-mix(in srgb,var(--primary) 11%,var(--paper));font-weight:700}
button.text-button{background:transparent;color:var(--vscode-textLink-foreground);border-color:transparent;padding-inline:3px}
#catalog-content :is(.actions,.course-preview footer) button:not(.secondary){background:var(--primary);color:var(--on-primary)}
#catalog-content .resume-card.first .actions button:not(.secondary){background:var(--warm);color:var(--on-warm)}
#catalog-content :is(.actions button,.type-chip,.text-button,select),.catalog-nav button{min-height:44px}
#open-guide{background:transparent;color:var(--vscode-foreground);border-color:var(--line)}
#more-results{display:block;margin:20px auto}#empty{padding:24px;text-align:center;background:var(--paper);border:1px solid var(--line);border-radius:16px}
#empty button{margin-top:12px}.explore-matches{min-width:0}
@media(max-width:759px){
  .home-feature:has(.home-other),.explore-layout{grid-template-columns:minmax(0,1fr)}
  #toggle-filters{display:inline-block;min-height:44px}#toggle-filters[aria-expanded=false]+.discovery-filters{display:none}
  .discovery-filters{margin-top:8px;grid-template-columns:repeat(2,minmax(0,1fr))}.discovery-filters h3{display:none}
  .home-other{grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))}
}
@media(max-width:450px){.catalog-bar{position:static}.discovery-filters{grid-template-columns:1fr}.result-tools{align-items:flex-start}}
body.learning-desktop{
  --canvas:var(--vscode-editor-background);--primary:var(--vscode-button-background);--on-primary:var(--vscode-button-foreground);
  --hero:#172a42;--hero-text:#f8fafc;--warm:#ff914d;--on-warm:#201007
}
.learning-desktop .catalog-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.learning-desktop .catalog-bar .top>.actions{order:2;margin-inline-start:auto}
.learning-desktop .view-link[aria-current=page]{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}
.learning-desktop .home-feature{align-items:start}
.learning-desktop .resume-card.first .actions{margin-top:5px}
.learning-desktop .resume-card.first{padding:clamp(20px,3vw,34px)}
.learning-desktop .catalog-help{border-top:1px solid var(--line);padding-top:12px}
.learning-desktop #open-guide{border-color:transparent;font-weight:400;color:var(--vscode-textLink-foreground)}
body:is(.vscode-high-contrast,.vscode-high-contrast-light){
  --primary:var(--vscode-button-background);--on-primary:var(--vscode-button-foreground);
  --warm:var(--primary);--on-warm:var(--on-primary);--hero:var(--paper);--hero-text:var(--vscode-foreground);
  --line:var(--vscode-contrastBorder,currentColor)
}
:is(.vscode-high-contrast,.vscode-high-contrast-light) :is(.type-chip,.track-tag,.suggestions button){
  --ink:var(--vscode-foreground);--wash:var(--paper);--edge:var(--line)
}
:is(.vscode-high-contrast,.vscode-high-contrast-light) .view-link[aria-current=page]{
  color:var(--vscode-foreground);background:var(--paper);text-decoration:underline;text-underline-offset:4px
}
:is(.vscode-high-contrast,.vscode-high-contrast-light) :is(.resume-card.first,button,.view-link[aria-current=page]){border-color:var(--line)}
${categoryCardStyles}
.resume-card.first[data-category-card]{background:var(--tint);color:var(--vscode-foreground);border-color:var(--accent)}
.offer[data-category-card] .offer-head{background:transparent}
`;
