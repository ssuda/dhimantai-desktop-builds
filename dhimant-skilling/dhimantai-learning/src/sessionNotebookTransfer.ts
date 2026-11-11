import { createHash } from 'node:crypto';
import type { NotebookCell } from './api';
import { notebookLink, NotebookLink } from './notebookSubmission';

export interface SessionNotebookLink extends Omit<NotebookLink, 'protocol'> {
  protocol: 2;
  transfer_id: string;
  base_revision: number;
}

export function sessionNotebookLink(metadata: any): SessionNotebookLink {
  const raw = metadata?.dhimantai;
  if (raw?.protocol !== 2 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw.transfer_id)
      || !Number.isSafeInteger(raw.base_revision) || raw.base_revision < 0 || raw.base_revision > 2 ** 31) {
    throw new Error('Choose Export for VS Code in the open Practice workspace, then open that notebook here.');
  }
  // Reuse the fixed-service/account/question validation. Never accept an arbitrary URL.
  const safe = notebookLink({ dhimantai: { ...raw, protocol: 1 } });
  return { ...safe, protocol: 2, transfer_id: raw.transfer_id, base_revision: raw.base_revision };
}

export interface TransferReceipt { status: 'applied' | 'review' | 'busy' | 'rejected'; revision: number }
export interface TransferOperation {
  digest: string;
  baseRevision: number;
  requestId: string;
  receipt?: TransferReceipt;
}
export interface TransferBody {
  request_id: string;
  base_revision: number;
  language: string;
  notebook: { nbformat: 4; cells: NotebookCell[] };
}

export function sessionNotebookDigest(language: string, cells: NotebookCell[]): string {
  return createHash('sha256').update(JSON.stringify([language, cells])).digest('hex');
}

/** Retry identity survives a lost reply; only metadata is held in extension memory. */
export async function sendSessionNotebook(link: SessionNotebookLink, cells: NotebookCell[],
  send: (body: TransferBody) => Promise<{ receipt: TransferReceipt }>,
  previous: TransferOperation | undefined, remember: (state: TransferOperation) => void) {
  const digest = sessionNotebookDigest(link.language, cells);
  const baseline = previous?.receipt?.status === 'applied' ? previous.receipt.revision : previous?.baseRevision ?? link.base_revision;
  const hex = createHash('sha256').update(JSON.stringify([link.transfer_id, link.export_id, baseline, digest])).digest('hex');
  const operation: TransferOperation = previous?.digest === digest ? previous : {
    digest, baseRevision: baseline,
    requestId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  };
  remember(operation);
  const result = await send({ request_id: operation.requestId, base_revision: operation.baseRevision,
    language: link.language, notebook: { nbformat: 4, cells } });
  if (!result?.receipt || !['applied', 'review', 'busy', 'rejected'].includes(result.receipt.status)
      || !Number.isSafeInteger(result.receipt.revision) || result.receipt.revision < 0) {
    throw new Error('The app did not return a valid receipt. Check the open workspace before retrying.');
  }
  remember({ ...operation, receipt: result.receipt });
  return result.receipt;
}
