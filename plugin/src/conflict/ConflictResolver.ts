import type { AncestorTracker } from './AncestorTracker';
import type { RemoteFsClient } from '../adapter/RemoteFsClient';
import type { ReadCache } from '../cache/ReadCache';
import { logger } from '../util/logger';
import { asError, errorMessage } from '../util/errorMessage';

export interface ThreeWayPanes {
  ancestor: string;
  mine: string;
  theirs: string;
}

export type TextConflictDecision =
  | { decision: 'keep-mine' }
  | { decision: 'keep-theirs' }
  | { decision: 'merged'; content: string }
  | { decision: 'cancel' };

export type WriteConflictCallback = (vaultPath: string) => Promise<boolean>;
export type TextConflictCallback = (
  vaultPath: string,
  panes: ThreeWayPanes,
) => Promise<TextConflictDecision>;

export interface ConnectedWriteRequest {
  signal: AbortSignal;
  checkConnected: () => void;
  validateMerge: (content: string) => void;
}

interface ConflictTransport {
  client: RemoteFsClient;
  request?: ConnectedWriteRequest;
}

async function waitForDecision<T>(decision: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return decision;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(asError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([decision, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * Handles write-conflict resolution when the remote file changed since
 * the user's last read (PreconditionFailed).
 *
 * Two paths:
 *   1. **3-way merge** — when `onTextConflict` is wired AND an ancestor
 *      snapshot exists, the user sees (ancestor / mine / theirs) and can
 *      keep-mine, keep-theirs, hand-merge, or cancel.
 *   2. **Two-choice fallback** — binary writes, or text writes without
 *      an ancestor, surface a simple overwrite-or-cancel modal.
 */
export class ConflictResolver {
  private client: RemoteFsClient;

  constructor(
    client: RemoteFsClient,
    private readonly readCache: ReadCache,
    private readonly ancestorTracker: AncestorTracker | null,
    private readonly onTextConflict: TextConflictCallback | null,
    private readonly onWriteConflict: WriteConflictCallback | null,
  ) {
    this.client = client;
  }

  swapClient(newClient: RemoteFsClient): void {
    this.client = newClient;
  }

  /**
   * Run the conflict-resolution stack (text 3-way → legacy two-choice
   * → rethrow). Returns the data that was actually written, which may
   * differ from the original write when the user chose `merged`. On
   * cancel / keep-theirs / no-callback, throws the original error so
   * the caller's outer try/catch in `writeBuffer` re-surfaces it.
   */
  async resolve(
    normalizedPath: string,
    remote: string,
    mine: Buffer,
    isText: boolean,
    originalError: unknown,
    request?: ConnectedWriteRequest,
  ): Promise<Buffer> {
    const transport = { client: this.client, request };
    if (isText && this.ancestorTracker && this.onTextConflict) {
      const ancestor = this.ancestorTracker.get(normalizedPath);
      if (ancestor !== null) {
        let theirsBuf: Buffer;
        try {
          theirsBuf = await transport.client.readBinary(remote);
        } catch (re) {
          request?.checkConnected();
          logger.warn(
            `ConflictResolver: re-read of "${remote}" failed (${errorMessage(re)}); ` +
            'falling back to the two-choice modal',
          );
          return await this.fallbackTwoChoice(normalizedPath, remote, mine, originalError, transport);
        }
        request?.checkConnected();
        const prompt = this.onTextConflict(normalizedPath, {
          ancestor: ancestor.content,
          mine:     mine.toString('utf8'),
          theirs:   theirsBuf.toString('utf8'),
        }).catch(() => ({ decision: 'cancel' as const }));
        const decision = await waitForDecision(prompt, request?.signal);
        request?.checkConnected();

        switch (decision.decision) {
          case 'keep-mine':
            await transport.client.writeBinary(remote, mine, undefined, request?.checkConnected);
            return mine;
          case 'merged': {
            request?.validateMerge(decision.content);
            const merged = Buffer.from(decision.content, 'utf8');
            await transport.client.writeBinary(remote, merged, undefined, request?.checkConnected);
            return merged;
          }
          case 'keep-theirs': {
            let mtime = 0;
            try {
              const s = await transport.client.stat(remote);
              mtime = s.mtime;
            } catch { /* best effort */ }
            request?.checkConnected();
            this.readCache.put(remote, theirsBuf, mtime);
            if (this.ancestorTracker) {
              this.ancestorTracker.remember(normalizedPath, theirsBuf.toString('utf8'), mtime);
            }
            throw originalError;
          }
          case 'cancel':
            throw originalError;
        }
      }
    }
    return await this.fallbackTwoChoice(normalizedPath, remote, mine, originalError, transport);
  }

  /**
   * Two-choice (overwrite / cancel) conflict path — the binary
   * fallback and the no-ancestor fallback for text. Throws on
   * cancel; returns `mine` on overwrite.
   */
  private async fallbackTwoChoice(
    normalizedPath: string,
    remote: string,
    mine: Buffer,
    originalError: unknown,
    { client, request }: ConflictTransport,
  ): Promise<Buffer> {
    if (!this.onWriteConflict) throw originalError;
    const prompt = this.onWriteConflict(normalizedPath).catch(() => false);
    const overwrite = await waitForDecision(prompt, request?.signal);
    request?.checkConnected();
    if (!overwrite) throw originalError;
    await client.writeBinary(remote, mine, undefined, request?.checkConnected);
    return mine;
  }
}
