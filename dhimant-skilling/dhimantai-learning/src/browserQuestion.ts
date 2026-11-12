export interface BrowserQuestion {
  id:string; task:string; kind:'prediction'|'explanation'|'reflection'; title:string; question:string;
  context:string; options:string[]; minLength:number; maxLength:number;
}

const object = (x:unknown):x is Record<string,any> => !!x && typeof x==='object' && !Array.isArray(x);
const text = (x:unknown,n:number):x is string => typeof x==='string' && x.length<=n;

export function validBrowserQuestion(value:unknown):value is BrowserQuestion {
  return object(value) && text(value.id,300) && !!value.id && text(value.task,100)
    && ['prediction','explanation','reflection'].includes(value.kind) && text(value.title,300)
    && text(value.question,1500) && !!value.question.trim() && text(value.context,2000)
    && Array.isArray(value.options) && value.options.length<=8 && value.options.every((v:unknown)=>text(v,500))
    && Number.isInteger(value.minLength) && value.minLength>=1 && Number.isInteger(value.maxLength)
    && value.maxLength>=value.minLength && value.maxLength<=800;
}
export function validBrowserAnswer(question:BrowserQuestion,answer:unknown):answer is string {
  return typeof answer==='string' && answer.trim().length>=question.minLength && answer.length<=question.maxLength
    && (!question.options.length || question.options.includes(answer));
}

export function browserAnswerMessage(question:BrowserQuestion,answer:string) {
  return `My ${question.kind} for “${question.title}”.\n${question.context}\nQuestion: ${question.question}\nMy answer: ${answer}\n`
    + (question.kind==='prediction' ? 'Acknowledge my prediction without revealing the outcome before I check my work.'
      : 'Check my reasoning against my records: say what is right, correct one gap, and ask one follow-up.');
}
