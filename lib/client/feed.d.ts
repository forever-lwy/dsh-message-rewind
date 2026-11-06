/**
 * Which parts of a transcript a rewind withdrew, and the stylesheet that
 * hides them.
 *
 * The official Chat keeps showing every append-origin event, so a rewound
 * exchange stays on screen unless something hides it. One feed per open
 * Session reads rewind markers from the Session event window — only the
 * entries each change adds, never a rescan per event — and turns their
 * ranges into a single `<style>` scoped to that Session's conversation: whole
 * Turns by `data-chat-turn`, single nodes by `data-chat-node-key` where a
 * rewind starts mid-Turn. Nothing observes the DOM; the stylesheet changes
 * only when a range changes or older history pages in.
 */
import type { RewindArmed } from '../remote.js';
export interface EventLike {
    type: string;
    seq: number;
    data?: any;
    surfaceOp?: unknown;
}
/** Half-open event-seq range a rewind withdrew; `keep` stays visible (a pending edit's own message). */
export interface HiddenRange {
    from: number;
    to: number;
    /** The rewound human message. */
    target: number;
    keep?: number;
}
interface EntryLike {
    type: string;
    event: EventLike;
}
interface WindowLike {
    entries: readonly EntryLike[];
    revision: number;
    change?: {
        kind: string;
        entries?: readonly unknown[];
    };
}
interface Observable<T> {
    getSnapshot(): T;
    subscribe(listener: () => void): () => void;
}
/** The parts of the Chat snapshot the stylesheet reads. */
export interface ChatLike {
    order?: readonly string[];
    nodes?: {
        values(): Iterable<{
            key: string;
            anchorSeq?: number;
            data?: any;
        }>;
    };
    timeline?: {
        turnOrder?: readonly number[];
    };
    locations?: {
        getTurn(turn: number): readonly string[];
    };
}
export declare function isHumanMessage(event: EventLike | undefined): boolean;
/**
 * Where a withdrawal starts: before the Turn when the message opened it, so
 * the Turn disappears whole, or at the message itself when it was steered in.
 * @param events - the loaded window in seq order.
 * @param index - position of the human message.
 */
export declare function withdrawalStart(events: readonly EventLike[], index: number): number;
/**
 * The range one marker withdrew, or null when `events[index]` is no rewind.
 * @param events - the loaded window in seq order.
 * @param index - position of a candidate marker.
 */
export declare function rewindRange(events: readonly EventLike[], index: number): HiddenRange | null;
/**
 * CSS hiding `ranges` inside one Session's conversation.
 * @param sessionId - Session whose conversation root carries `data-conversation-session`.
 * @param ranges - withdrawn ranges.
 * @param turnStarts - Turn number → its `turn/start` seq.
 * @param chat - current Chat snapshot.
 */
export declare function hidingCss(sessionId: string, ranges: readonly HiddenRange[], turnStarts: ReadonlyMap<number, number>, chat: ChatLike | undefined): string;
export interface FeedDeps {
    events: Observable<WindowLike> | undefined;
    chat: Observable<ChatLike | undefined> | undefined;
    state?: () => Promise<{
        armed: RewindArmed | null;
    }>;
    /** Install or replace this Session's stylesheet; empty text removes it. */
    writeCss: (css: string) => void;
}
/** Withdrawn ranges and the pending edit of one Session. */
export declare class SessionFeed {
    readonly sessionId: string;
    private readonly deps;
    private ranges;
    private readonly turnStarts;
    private armed;
    private revision;
    private eventRevision;
    private readonly listeners;
    private readonly stops;
    private chatStop;
    private lastOrder;
    private lastCss;
    constructor(sessionId: string, deps: FeedDeps);
    subscribe: (listener: () => void) => () => void;
    getRevision: () => number;
    /** Whether the message at `seq` was withdrawn (or is pending withdrawal). */
    isHidden(seq: number): boolean;
    armedSeq(): number | null;
    /** Mark a pending edit: `armed.seq` through `armed.lastSeq` leave the transcript until it is sent or undone. */
    setArmed(armed: RewindArmed | null): void;
    hiddenRanges(): readonly HiddenRange[];
    dispose(): void;
    private visibleRanges;
    private events;
    /** Scan only the entries the latest change added. */
    private read;
    private changed;
    private restyle;
}
/** Reference-counted feeds, one per Session shown in a conversation. */
export declare class FeedRegistry {
    private readonly create;
    private readonly graceMs;
    private readonly feeds;
    constructor(create: (sessionId: string) => SessionFeed, graceMs?: number);
    peek(sessionId: string): SessionFeed | undefined;
    /** The feed for `sessionId`, created on first use; unheld, it lapses after the grace period. */
    ensure(sessionId: string): SessionFeed;
    acquire(sessionId: string): SessionFeed;
    /** Rows mount and unmount as the transcript pages; a feed outlives a short gap. */
    release(sessionId: string): void;
    private schedule;
    dispose(): void;
}
export {};
