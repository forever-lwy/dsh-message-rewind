import { type RewindFace } from './components.js';
import type { FeedRegistry } from './feed.js';
export declare const NODE_SLOT = "conversation.chat.node";
export interface StoredEntryLike {
    component: unknown;
    options: {
        key?: string;
        priority?: number;
    };
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
export declare function createUserNodeRenderer(slots: Pick<SlotsLike, 'entries' | 'subscribe'>, face: RewindFace, feeds?: FeedRegistry): (props: any) => import("react").JSX.Element | null;
export declare function createRetryAction(face: RewindFace): (props: any) => import("react").JSX.Element | null;
