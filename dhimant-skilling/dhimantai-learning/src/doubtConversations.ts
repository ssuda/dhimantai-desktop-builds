import {createHash, randomUUID} from 'node:crypto';
import {readdir, stat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {emptyNotebook, NOTEBOOK_LIMIT, readNotebook, TutorNotebook} from './tutorNotebook';
import {TutorNotebookStore} from './tutorNotebookStore';

export const validDoubtId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export type DoubtConversation = {id:string; title:string; course:string; chapter:string; modified:number};
export function doubtTitle(book:TutorNotebook) {
  return (book.cells.find(cell => cell.kind === 'message' && !cell.packet?.action)?.text
    .replace(/\s+/g, ' ').trim().slice(0, 90) || 'New chat');
}
/** Each conversation has its own conflict-checked document; paths are bound to account and environment. */
export class DoubtConversations {
  constructor(private directory:string, private environment:string, private account:string) {}
  store(id:string) {
    if (!validDoubtId(id)) throw new Error('Choose a saved chat.');
    return new TutorNotebookStore(this.directory, this.environment, this.account + '\0doubt-chat:' + id);
  }
  async list():Promise<DoubtConversation[]> {
    let files:string[];
    try {files=await readdir(this.directory);} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const items:DoubtConversation[]=[];
    for(const file of files.filter(file=>/^[0-9a-f]{64}\.json$/.test(file))) {
      try {
        const path=join(this.directory,file), info=await stat(path);
        if(info.size>NOTEBOOK_LIMIT*4)continue;
        const book=readNotebook(JSON.parse(await readFile(path,'utf8')));
        if(!validDoubtId(book.doubtId) || !book.doubtCourse || !book.lessonId || this.store(book.doubtId).file!==path)continue;
        items.push({id:book.doubtId,title:doubtTitle(book),course:book.doubtCourse,chapter:book.lessonId,modified:info.mtimeMs});
      } catch { /* Keep readable chats available when an unrelated file is damaged. */ }
    }
    return items.sort((a,b)=>b.modified-a.modified || a.id.localeCompare(b.id));
  }
  async create(course:string, chapter:string) {
    const book={...emptyNotebook(),title:'New chat',doubtId:randomUUID(),doubtCourse:course,lessonId:chapter};
    const store=this.store(book.doubtId);await store.load();await store.save(book);
    return {store,book};
  }
  async open(id:string) {
    const store=this.store(id), book=await store.load();
    if(book.doubtId!==id || !book.doubtCourse || !book.lessonId)throw new Error('This saved chat is unavailable.');
    return {store,book};
  }
  /** Idempotent migration leaves the original document intact and splits legacy divider groups. */
  async migrate(course:string, chapter:string) {
    const legacy=new TutorNotebookStore(this.directory,this.environment,this.account+'\0doubt_solver:'+course);
    const book=await legacy.load();
    if(!book.cells.length && !book.drafts.length && !book.textDraft)return;
    const groups:typeof book.cells[]=[];
    for(const cell of book.cells) {
      if(!groups.length || cell.packet?.doubt_divider===true)groups.push([]);
      groups.at(-1)!.push(cell);
    }
    if(!groups.length)groups.push([]);
    for(const [index,cells] of groups.entries()) {
      const digest=createHash('sha256').update(course+'\0'+(cells[0]?.id??'draft')).digest('hex').slice(0,32);
      const id=[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20)].join('-');
      const store=this.store(id), existing=await store.load();
      if(existing.doubtId)continue;
      const ids=new Set(cells.map(cell=>cell.id)), final=index===groups.length-1;
      const migrated:TutorNotebook={...book,doubtId:id,doubtCourse:course,lessonId:book.lessonId||chapter,cells,
        drafts:book.drafts.filter(draft=>ids.has(draft.key.split(':')[0]) || (final && draft.key.startsWith('checkpoint:'))),
        textDraft:final?book.textDraft:'',attemptDraft:final?book.attemptDraft:'',executionIssues:undefined};
      migrated.title=doubtTitle(migrated);await store.save(migrated);
    }
  }
}
