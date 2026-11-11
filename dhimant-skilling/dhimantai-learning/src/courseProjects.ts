import * as vscode from 'vscode';
import { Auth } from './auth';
import { Api } from './api';
import { Environment, EnvironmentName } from './environments';
import { createGuidedProject } from './skillingActions';

/** The catalog and roadmap use the same authored briefs, eligibility and project setup. */
export function registerCourseProjects(context: vscode.ExtensionContext, auth: Auth,
    environment: () => EnvironmentName, service: () => Environment) {
  return vscode.commands.registerCommand('dhimantai.startCourseProject', async (course: string) => {
    if (typeof course !== 'string' || !course) return;
    try {
      const owner = (await auth.session() ?? await auth.signIn())?.user.id;
      if (!owner) return;
      const selectedEnvironment = environment(), backend = service();
      const current = async () => environment() === selectedEnvironment && (await auth.session())?.user.id === owner;
      const api = new Api(auth, () => {
        if (environment() !== selectedEnvironment) throw new Error('Your service changed. Choose your project again.');
        return backend;
      }, owner);
      const {pathway} = await api.skillingPathway(course);
      if (!await current()) return;
      if (!pathway.profile) throw new Error('Project briefs are not available for this course yet.');
      const levels = [
        {id:'micro', label:'Micro project', detail:'Practise one concept with normal and boundary cases.'},
        {id:'minor', label:'Minor project', detail:'Combine concepts with integration tests and failure handling.'},
        {id:'major', label:'Final capstone project', detail:'Build, test, demonstrate and hand off an end-to-end application.'},
      ].map(level => ({...level, unlocked: !!pathway.milestones.find(m => m.id === level.id)?.unlocked,
        description: pathway.milestones.find(m => m.id === level.id)?.unlocked ? 'Ready to start' : 'Prerequisites required'}));
      const level = await vscode.window.showQuickPick(levels, {title:`Projects · ${pathway.profile.title}`});
      if (!level || !await current()) return;
      if (!level.unlocked) {
        const action = await vscode.window.showInformationMessage('Complete the prerequisite milestones in your course roadmap before starting this project.', 'Open roadmap');
        if (action && await current()) await vscode.commands.executeCommand('dhimantai.courseGrade', course);
        return;
      }
      const brief = await vscode.window.showQuickPick([
        {label:'Use the course project brief', detail:pathway.profile.project_theme, custom:false},
        {label:'Set up a custom project', detail:'Describe your problem, users, constraints and acceptance criteria.', custom:true},
      ], {title:level.label});
      if (!brief || !await current()) return;
      const requirements = brief.custom ? await vscode.window.showInputBox({title:'Custom project requirements',
        prompt:'Describe the problem, users, constraints and what a successful result must do (30–4,000 characters).',
        ignoreFocusOut:true, validateInput:value => value.trim().length < 30 || value.trim().length > 4000
          ? 'Use 30 to 4,000 characters to describe your project.' : undefined}) : '';
      if (requirements === undefined || !await current()) return;
      const plan = await api.skillingBrief(course, level.id, requirements.trim());
      if (await current()) await createGuidedProject(context, plan, current);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not set up the project. Try again.');
    }
  });
}
