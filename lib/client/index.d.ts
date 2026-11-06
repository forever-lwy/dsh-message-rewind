/**
 * Browser half: rewind and regenerate buttons under every user message, a
 * regenerate button in the latest reply's action strip, and the stylesheet
 * that hides what a rewind withdrew.
 *
 * rc.5 offers no action slot on user messages, so this plugin shadows the
 * official `user`/`steering` Chat Node renderers at a lower priority and
 * renders the current official renderer unchanged above its own row; the
 * official entry is looked up at render time, so it follows HMR and stays the
 * owner of the bubble itself.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-message-rewind-client";
export declare const inject: string[];
export { RewindController } from './controller.js';
export { ArmedNotice, RewindButton, UserRewindActions, describe, retryTarget } from './components.js';
export { FeedRegistry, SessionFeed, hidingCss, rewindRange, withdrawalStart } from './feed.js';
export { createRetryAction, createUserNodeRenderer, officialRenderer } from './renderers.js';
export declare function apply(ctx: Context): Promise<void>;
