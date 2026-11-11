import { randomUUID } from 'node:crypto';

export interface NotebookCoachMessage {
  id: string;
  role: 'learner' | 'tutor' | 'status';
  text: string;
  cell: string;
  revision: number;
  context?: string;
}

/** Temporary, per-notebook chat. Never persisted as learning or run evidence. */
export class NotebookCoachConversation {
  id = randomUUID();
  readonly messages: NotebookCoachMessage[] = [];
  private account?: string;
  private scope?: string;

  forScope(scope: string) {
    const changed = this.scope !== undefined && this.scope !== scope;
    if (changed) this.clear();
    this.scope = scope;
    return changed;
  }

  forAccount(account: string) {
    if (this.account && this.account !== account) this.clear();
    this.account = account;
  }

  clear() { this.messages.length = 0; this.id = randomUUID(); }

  history(cell: string, revision: number, before?: string) {
    const prior = before ? this.messages.slice(0, Math.max(0, this.messages.findIndex(message => message.id === before))) : this.messages;
    return prior.filter(message => message.cell === cell && message.role !== 'status').slice(-8)
      .map(message => ({role: message.role as 'learner' | 'tutor', text: (
        (message.revision === revision ? '' : '[Earlier cell version or run; current code and output take precedence.]\n') + message.text
      ).slice(0, 1500)}));
  }
}
