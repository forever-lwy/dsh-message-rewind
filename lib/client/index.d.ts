/**
 * Browser half: rewind and regenerate buttons under every user message, a
 * regenerate button in the latest reply's action strip, and the stylesheet
 * that hides what a rewind withdrew.
 *
 * DSH offers no action slot on user messages, so this plugin shadows the
 * official `user`/`steering` Chat Node renderers at a lower priority and
 * renders the current official renderer above its own row; the official entry
 * is looked up at render time, so it follows HMR and stays the owner of the
 * bubble itself. Since 0.2.2 the bubble needs a `renderSlotChain` for
 * `conversation.chat.user.before`, which the renderer gives only to that
 * slot's declarer; the shadow declares a mirror of it instead (renderers.tsx).
 * A shadow that throws while rendering is retired from its cell until reload.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-message-rewind-client";
export declare const inject: string[];
export { RewindController } from './controller.js';
export { ArmedNotice, RewindButton, UserRewindActions, describe, retryTarget } from './components.js';
export { FeedRegistry, SessionFeed, hidingCss, rewindRange, withdrawalStart } from './feed.js';
export { createRetryAction, createUserNodeRenderer, mirrorUserBefore, officialChain, officialRenderer, registerUserNodes } from './renderers.js';
export declare function apply(ctx: Context): Promise<void>;
