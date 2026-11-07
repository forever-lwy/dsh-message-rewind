/** Chat renderers: the user-message shadow and the retry action. */
import { type ReactNode } from 'react';
import { type RewindFace } from './components.js';
import type { FeedRegistry } from './feed.js';
export declare const NODE_SLOT = "conversation.chat.node";
/** Official chain the `user` bubble renders above its content (liveshare's origin line, for one). */
export declare const USER_BEFORE_SLOT = "conversation.chat.user.before";
/**
 * This plugin's copy of {@link USER_BEFORE_SLOT}. The renderer hands
 * `renderSlotChain` only to an entry that declares a chain child, and only
 * for its own children; the official renderer declared the original, so the
 * shadow declares this copy and keeps it in sync.
 */
export declare const USER_BEFORE_MIRROR = "dsh-message-rewind.user.before";
export interface StoredEntryLike {
    component: unknown;
    options: {
        key?: string;
        priority?: number;
    };
    select?: unknown;
    inject?: unknown;
    locale?: string;
    store?: unknown;
    registrant?: string;
}
export interface SlotsLike {
    entries(key: string): readonly StoredEntryLike[];
    subscribe(key: string, fn: () => void): () => void;
    inject(key: string, fn: () => unknown): void;
    register(options: Record<string, unknown>, component: unknown): () => void;
}
/**
 * Pick the renderer this plugin shadows: the lowest-priority other entry for `key`.
 * @param slots - slot registry.
 * @param key - Chat Node kind.
 * @param self - this plugin's component.
 */
export declare function officialRenderer(slots: Pick<SlotsLike, 'entries'>, key: string, self: unknown): ((props: any) => any) | undefined;
type RenderSlotChain = (key: string, owner: unknown, options?: {
    fallback?: ReactNode;
}) => ReactNode;
/**
 * The `renderSlotChain` the official renderer gets through the shadow: the
 * shadow's own binding with {@link USER_BEFORE_SLOT} routed to the mirror, or
 * the fallback when the entry received none.
 * @param own - `renderSlotChain` the renderer gave the shadow entry, if any.
 */
export declare function officialChain(own: unknown): RenderSlotChain;
/**
 * Copy every entry of {@link USER_BEFORE_SLOT} into {@link USER_BEFORE_MIRROR},
 * in ledger order, until the returned disposer runs. Start it while the
 * mirror is declared.
 * @param slots - slot registry.
 * @param onError - a copy that failed to register; the chain renders without it.
 */
export declare function mirrorUserBefore(slots: Pick<SlotsLike, 'entries' | 'subscribe' | 'register'>, onError?: (error: unknown) => void): () => void;
/**
 * Register the `user`/`steering` shadows and the chain mirror. Each call to
 * `slots.inject` follows its slot's declaration lifetime.
 * @param slots - slot registry of the plugin's fiber.
 * @param component - the shadow from {@link createUserNodeRenderer}.
 * @param priority - below the official entries' priority.
 */
export declare function registerUserNodes(slots: SlotsLike, component: unknown, priority: number): void;
export declare function createUserNodeRenderer(slots: Pick<SlotsLike, 'entries' | 'subscribe'>, face: RewindFace, feeds?: FeedRegistry): (props: any) => import("react").JSX.Element | null;
export declare function createRetryAction(face: RewindFace): (props: any) => import("react").JSX.Element | null;
export {};
