import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import { type RewindArmed, type RewindArmResult, type RewindAttachmentData, type RewindInspection, type RewindModified, type RewindRetryResult } from './remote.js';
export declare const name = "dsh-message-rewind";
export declare const inject: string[];
export interface Settings {
    mutatingTools: string[];
    attachmentMaxBytes: number;
    stopTimeoutMs: number;
}
export declare const Config: z<Settings>;
/** The event fields these reads depend on. */
export interface EventLike {
    type: string;
    seq: number;
    data?: any;
}
/** One content block of a durable user message. */
export type MessageBlock = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    attachment: {
        attachmentId: string;
        mediaType: string;
        bytes: number;
        name?: string;
    };
} | {
    type: 'file';
    attachment: {
        attachmentId: string;
        name: string;
        bytes: number;
    };
} | {
    type: string;
    [key: string]: unknown;
};
export interface SessionLike {
    id: string;
    seq: number;
    surface: {
        nodes: readonly number[];
    };
    eventAt(seq: number): EventLike | undefined;
    snapshotEvents(from?: number, to?: number): readonly EventLike[];
    append(type: string, data: unknown, options?: unknown): EventLike;
}
export interface AgentLike {
    id: string;
    status: string;
    session: SessionLike;
    cancel(cause: {
        kind: 'user';
    }, options?: {
        keepInbox?: boolean;
    }): void;
    whenIdle(): Promise<void>;
    followup(message: unknown): void;
}
interface MessageLike {
    id?: string;
    content?: unknown;
    source?: {
        kind?: unknown;
        rpcId?: unknown;
    };
}
type Refusal = RewindInspection['refusal'];
/** Whether one event is a message the human sent (not runtime context or other injected input). */
export declare function isHumanMessage(event: EventLike | undefined): boolean;
/**
 * Why `seq` cannot be rewound in place, or null when it can.
 * @param session - the live Session.
 * @param seq - candidate human message.
 */
export declare function refusalOf(session: SessionLike, seq: number): Refusal;
/**
 * Workspace edits and human messages recorded after `seq`.
 * @param events - the log from `seq` on.
 * @param seq - target message.
 * @param tools - names of file-editing tools.
 * @param surface - current surface nodes, to count only messages still in context.
 */
export declare function laterActivity(events: readonly EventLike[], seq: number, tools: readonly string[], surface: readonly number[]): {
    modified: RewindModified;
    laterMessages: number;
};
/**
 * Shadow `target` and every later surface node with one empty system message.
 * @param session - the live Session, between `agent/request` and the step's input.
 * @param target - human message to withdraw.
 * @param turn - current turn.
 * @param step - current step.
 * @returns the marker event.
 */
export declare function rewindSurface(session: SessionLike, target: number, turn: number, step: number): EventLike;
declare module '@deepseek-ai/cordis' {
    interface Context {
        messageRewind: MessageRewindService;
    }
}
export declare class MessageRewindService extends TypertRemoteService {
    private readonly settings;
    /** Edits waiting for the next human message, per live Agent. */
    private readonly armed;
    /** Retried messages by id → the target they replace. */
    private readonly retries;
    /** Rewinds to apply at this Agent's next matching `agent/request`. */
    private readonly plans;
    private readonly inflight;
    constructor(ctx: Context, settings: () => Settings);
    private lookup;
    private agent;
    private describe;
    /** Stop a running Agent, discarding its queued input: all of it comes after the target. */
    private stop;
    /**
     * Stop the Agent, re-check the target, and run `act` unless stopping
     * surfaced workspace edits the person has not been warned about.
     */
    private prepare;
    inspect(request: unknown, signal: AbortSignal): Promise<RewindInspection>;
    attachment(request: unknown, signal: AbortSignal): Promise<RewindAttachmentData>;
    arm(request: unknown, signal: AbortSignal): Promise<RewindArmResult>;
    disarm(request: unknown): Promise<{
        ok: true;
    }>;
    state(request: unknown): Promise<{
        armed: RewindArmed | null;
    }>;
    retry(request: unknown, signal: AbortSignal): Promise<RewindRetryResult>;
    /** `agent/pre-step`: a step admitting a retried or edited message plans its rewind. */
    claim(agent: AgentLike, messages: readonly MessageLike[], turn: number, step: number): void;
    /** `agent/request`: shadow the withdrawn range before the step's new message is admitted. */
    apply(agent: AgentLike, turn: number, step: number): void;
}
export declare function apply(ctx: Context, config?: Partial<Settings>): void;
export {};
