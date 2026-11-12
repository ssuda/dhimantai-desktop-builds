import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export function desktopExtensionPath(appRoot:string) {
  return join(appRoot, 'extensions', 'optficial.dhimantai-learning');
}

/** Older desktop extensions persisted the then-hidden default as a user setting.
 * Reveal the new rail once on upgrade; subsequent learner layout choices win. */
export async function migrateDesktopAppBar(store: {
  get(key: string): unknown; update(key: string, value: boolean): PromiseLike<void>;
}, settings: {
  inspect(key: string): {globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown} | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}) {
  if (store.get('desktopAppBarIntroduced')) return;
  const value = settings.inspect('workbench.activityBar.location');
  if (value?.globalValue === 'hidden' && value.workspaceValue === undefined && value.workspaceFolderValue === undefined) {
    await settings.update('workbench.activityBar.location', 'default');
  }
  await store.update('desktopAppBarIntroduced', true);
}

/** A user-installed update shadows the bundled manifest. Keep the desktop's
 * existing defaults without replacing a learner's explicit preferences. */
export async function preserveDesktopDefaults(appRoot:string, settings:{
  inspect(key:string):{globalValue?:unknown; workspaceValue?:unknown; workspaceFolderValue?:unknown}|undefined;
  update(key:string,value:unknown):PromiseLike<void>;
}) {
  const manifest=JSON.parse(await readFile(join(desktopExtensionPath(appRoot),'package.json'),'utf8'));
  if (manifest.publisher!=='optficial' || manifest.name!=='dhimantai-learning') throw new Error('Invalid bundled learning extension.');
  const defaults={...manifest.contributes?.configurationDefaults, 'dhimantai.autoUpdate':true};
  for(const key of ['dhimantai.environment','dhimantai.autoUpdate','workbench.startupEditor','workbench.colorTheme','workbench.activityBar.location','workbench.activityBar.compact']) {
    const value=defaults[key], explicit=settings.inspect(key);
    if((typeof value!=='string' && typeof value!=='boolean') || explicit?.globalValue!==undefined || explicit?.workspaceValue!==undefined
        || explicit?.workspaceFolderValue!==undefined) continue;
    await settings.update(key,value);
  }
}
