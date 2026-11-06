/**
 * Browser-side rewind steps over the public Client services.
 *
 * - Edit: read the message's attachments back, arm the Host (which stops a
 *   running task first), then put the text and attachments into the composer.
 *   The next send replaces the message.
 * - Retry: ask the Host to send the original message again in place.
 */
import type { RewindInspection, RewindRemote } from '../remote.js';
import type { SessionFeed } from './feed.js';
export type RewindMode = 'edit' | 'retry';
/** A failure or notice surfaced to the person after the operation. */
export interface RewindNotice {
    key: string;
    values?: Record<string, string | number>;
}
export interface RewindOptions {
    /** The person already saw the workspace-edit warning. */
    knownModified: boolean;
    /** Sentence appended to the message telling the model the workspace was not rewound. */
    note: string | null;
}
export type RewindOutcome = {
    status: 'done';
    notices: RewindNotice[];
}
/** Stopping the task surfaced edits not shown yet; nothing changed. */
 | {
    status: 'confirm';
    inspection: RewindInspection;
};
interface SessionInputLike {
    setDraft(text: string): void;
    addAttachments(ids: readonly string[]): boolean;
    focus?(): void;
}
/** The Client services the steps use, narrowed for tests. */
export interface RewindDeps {
    remote: RewindRemote;
    sessions: {
        list: {
            getSnapshot(): {
                byId: Record<string, {
                    running?: boolean;
                } | undefined>;
            };
        };
        scope(id: string): unknown;
    };
    conversation: {
        input: {
            for(actx: unknown): SessionInputLike;
        };
        createDrafts(sessionId: string, files: readonly File[]): readonly {
            id: string;
        }[];
    };
    feed(sessionId: string): SessionFeed | undefined;
}
export declare class RewindController {
    private readonly deps;
    /** One rewind at a time per Session. */
    private readonly busy;
    constructor(deps: RewindDeps);
    isRunning(sessionId: string): boolean;
    inspect(sessionId: string, seq: number): Promise<RewindInspection>;
    /**
     * Rewind `sessionId` to just before message `info.seq`.
     * @param sessionId - Session to rewind.
     * @param info - inspection returned by {@link inspect}.
     * @param mode - edit returns the message to the composer; retry sends it again.
     * @param options - warning acknowledgement and the optional note.
     */
    run(sessionId: string, info: RewindInspection, mode: RewindMode, options: RewindOptions): Promise<RewindOutcome>;
    /** Withdraw a pending edit; the transcript shows the message again. */
    undo(sessionId: string): Promise<void>;
    private retry;
    private edit;
}
export {};
