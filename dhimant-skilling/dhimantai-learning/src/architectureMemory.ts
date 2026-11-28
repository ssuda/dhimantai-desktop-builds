import { GitEvidence, GitSkill, gitProjects, isGitProject } from './gitPractice';
export interface ArchitectureAttempt {
  prior_practice: boolean;
  help: string[];
  first_diagnosis: 'located' | 'missed' | 'after_edit' | null;
  recognition_help: string[] | null;
  repair_help: string[] | null;
  repair_digest: string | null;
  test_help?: string[] | null;
  test_digest?: string | null;
  git_evidence?: Partial<Record<GitSkill,{digest:string; help:string[]}>>;
  complete_digest?: string | null;
}

export type ArchitectureAttempts = Record<string, ArchitectureAttempt | undefined>;
export type ArchitectureEvent =
  | {event:'started' | 'external_help'}
  | {event:'hint'; hint_level:1 | 2}
  | {event:'diagnosis'; location:string; prediction:number; digest:string}
  | ({event:'git_check'; digest:string} & GitEvidence)
  | {event:'git_hint'; skills:[GitSkill]}
  | {event:'passed' | DebugCheckEvent; digest:string};

const helpNames: Record<string,string> = {
  branch:'help choosing a branch', commits:'help organizing commits', conflict:'help resolving a conflict',
  reproduce:'help reproducing the failure', isolate:'help isolating the cause', regression:'help designing the regression test',
  reproduce_hint:'a reproduction hint', isolate_hint:'an isolation hint', regression_hint:'a regression-test hint',
  inspection_hint:'a tracing hint', design_hint:'a design hint', discussion:'an Instructor discussion',
  trace:'help tracing the behavior', design:'help choosing the design', verification:'help verifying the repair',
  automatic_guidance:'an Instructor observation', external_help:'reported outside help',
};

function support(help: string[]) {
  return help.length ? 'with ' + help.map(key => helpNames[key] ?? key).join(' and ') : 'without recorded help';
}

export function waitsForIndependentAttempt(project: string, attempt?: ArchitectureAttempt) {
  return Object.hasOwn(transferTitles, project) && !((isDebugProject(project) || isGitProject(project)) ? attempt?.complete_digest : attempt?.repair_digest)
    && !attempt?.help.some(kind => kind !== 'external_help');
}

export function architectureSummary(project: string, attempts: ArchitectureAttempts) {
  const attempt = attempts[project], guided = attempts['market-checkout'];
  const messages: string[] = [];
  if (waitsForIndependentAttempt(project, attempt))
    messages.push('Try this case independently. The Instructor waits until you ask for help.');
  if (isGitProject(project)) {
    for (const [skill, label] of [['branch','You worked on a separate branch'],['commits','You made two focused commits'],
      ['conflict','You reconciled both sides of the merge']] as const) {
      const evidence = attempt?.git_evidence?.[skill];
      if (evidence) messages.push(label + ' ' + support(evidence.help) + '.');
    }
    return messages.join(' ');
  }
  if (attempt?.recognition_help) {
    const when = attempt.first_diagnosis === 'located' ? 'on your first prediction' : 'after another prediction';
    const issue = isDebugProject(project) ? 'original bug'
      : ['museum-entry', 'workshop-enrolment'].includes(project) ? 'inconsistent rule' : 'original side effect';
    messages.push('You located the ' + issue + ' ' + when + ', ' + support(attempt.recognition_help) + '.');
  } else if (attempt?.first_diagnosis === 'after_edit')
    messages.push('Your first prediction followed an edit. Recognition before editing is unverified.');
  else if (attempt?.first_diagnosis === 'missed')
    messages.push('Your first prediction missed the original behavior.' + (attempt.repair_help ? '' : ' You can try another location and count.'));
  if (attempt?.repair_help && attempt.recognition_help === null && attempt.first_diagnosis === null)
    messages.push('Recognition before the repair was not observed.');
  if (attempt?.repair_help) {
    const repair = project === 'market-checkout' ? 'Your first recorded repair' : 'Your local repair';
    messages.push(repair + ' passed ' + support(attempt.repair_help) + '.');
  } else if (attempt?.help.length) messages.push('You have worked ' + support(attempt.help) + '.');
  if (attempt?.test_help) messages.push('Your test caught the original bug ' + support(attempt.test_help) + '.');
  if (project === 'field-dispatch' && attempt?.prior_practice && attempt.repair_help && guided?.repair_help)
    messages.push('Earlier, you completed Checkout previews ' + support(guided.repair_help) + '.');
  return messages.join(' ');
}

export const debugProjects: Record<string, {title:string; file:string; description:string; reproduction:string}> = {
  'trail-log': {title:'Trail log', file:'trips.py', description:'Investigate a walking guide’s itinerary report.',
    reproduction:'from trips import record_stop\nprint(record_stop("Station"))\nprint(record_stop("Museum"))'},
  'print-batches': {title:'Print batches', file:'labels.py', description:'Investigate a print operator’s label counts.',
    reproduction:'from labels import Batch\nfirst = Batch()\nfirst.add("A")\nfirst.add("B")\nprint(Batch().add("C"))'},
  'ferry-fares': {title:'Ferry fares', file:'fares.py', description:'Investigate a disputed passenger fare.',
    reproduction:'from fares import fare\nprint(sum(fare(age) for age in (11, 12, 13)))'},
  'meter-blocks': {title:'Parking meter', file:'meter.py', description:'Investigate a driver’s parking bill.',
    reproduction:'from meter import blocks\nprint(blocks(45))'},
};

export function isDebugProject(id: string) { return Object.hasOwn(debugProjects, id); }

export type DebugCheckEvent = 'verified_together' | 'repair_checked' | 'test_checked' | 'both_checked';
export function debugCheckEvent(code: number | null): DebugCheckEvent | undefined {
  switch (code) {
    case 0: return 'verified_together';
    case 10: return 'repair_checked';
    case 11: return 'test_checked';
    case 12: return 'both_checked';
    default: return undefined;
  }
}

export const transferTitles: Record<string, string> = {
  ...gitProjects,
  ...Object.fromEntries(Object.entries(debugProjects).map(([id, project]) => [id, project.title])),
  'field-dispatch': 'Field service dispatch', 'parcel-pickup': 'Parcel pickup',
  'museum-entry': 'Museum entry', 'workshop-enrolment': 'Workshop enrolment',
};

export function architectureCase(id: string) {
  return id === 'market-checkout' || Object.hasOwn(transferTitles, id);
}

export interface PracticeFollowup {
  project: string | null;
  due_at: string | null;
  origins: Record<string, {file:string; line:number; help:string[]; skill:string}>;
}

export type ArchitectureHelp = 'trace' | 'design' | 'verification' | 'reproduce' | 'isolate' | 'regression' | GitSkill;
export type ArchitectureTopic = {skill:'query-write' | 'policy-drift' | 'shared-state' | 'test-oracle' | `git-${GitSkill}`; file?:string; line?:number; help:ArchitectureHelp | 'noticed'};

export function originSummary(origin?: PracticeFollowup['origins'][string]) {
  if (!origin) return '';
  const skills:Record<string,string> = {branch:'choosing a branch', commits:'organizing commits', conflict:'resolving a merge conflict', reproduce:'reproducing the failure', isolate:'isolating the cause', regression:'writing a regression test', trace:'tracing the behavior', design:'choosing the design', verification:'verifying the change'};
  return 'In your own project, you asked for help ' + origin.help.map(key => skills[key]).join(' and ')
    + (origin.line ? ' at ' + origin.file + ':' + origin.line : origin.file === '(repository)' ? '' : ' in ' + origin.file) + '.';
}
