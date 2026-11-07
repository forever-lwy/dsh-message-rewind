import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { bindRemote, remoteInfo } from '../remote.js';
import { RewindController } from './controller.js';
import { FeedRegistry, SessionFeed } from './feed.js';
import { createRetryAction, createUserNodeRenderer, registerUserNodes } from './renderers.js';
import { en, zh } from './locales.js';
import { styles } from './styles.js';
export const name = 'dsh-message-rewind-client';
export const inject = ['slots', 'locale', 'remote'];
const PACKAGE = '@forever-lwy/dsh-message-rewind';
const namespace = 'messageRewind';
/** Below the official renderer's default priority 0, so this entry wins its cell. */
const SHADOW_PRIORITY = -10;
export { RewindController } from './controller.js';
export { ArmedNotice, RewindButton, UserRewindActions, describe, retryTarget } from './components.js';
export { FeedRegistry, SessionFeed, hidingCss, rewindRange, withdrawalStart } from './feed.js';
export { createRetryAction, createUserNodeRenderer, mirrorUserBefore, officialChain, officialRenderer, registerUserNodes } from './renderers.js';
/** One `<style>` per Session holding its hiding rules. */
function cssWriter(sessionId) {
    let node;
    return css => {
        if (css === '') {
            node?.remove();
            node = undefined;
            return;
        }
        if (node === undefined) {
            node = document.createElement('style');
            node.dataset.plugin = `${PACKAGE}-hidden`;
            node.dataset.session = sessionId;
            document.head.appendChild(node);
        }
        node.textContent = css;
    };
}
export async function apply(ctx) {
    const unmount = await ctx.remote.$mount(remoteInfo);
    ctx.effect(() => unmount, 'message-rewind: remote schema');
    ctx.effect(() => ctx.locale.register(namespace, 'zh', zh), 'message-rewind: Chinese');
    ctx.effect(() => ctx.locale.register(namespace, 'en', en), 'message-rewind: English');
    ctx.effect(() => {
        const node = document.createElement('style');
        node.dataset.plugin = PACKAGE;
        node.textContent = styles;
        document.head.appendChild(node);
        return () => node.remove();
    }, 'message-rewind: styles');
    const t = ctx.locale.bind(namespace);
    const anyPrimitives = primitives;
    ctx.inject(['remote.messageRewind', 'sessions', 'conversation', 'uiConversation'], (scoped) => {
        const c = scoped;
        const remote = bindRemote(c.remote);
        const feeds = new FeedRegistry(sessionId => new SessionFeed(sessionId, {
            events: c.sessions.binding(sessionId)?.eventSource,
            chat: (() => { try {
                return c.uiConversation.binding(sessionId).target('chat');
            }
            catch {
                return undefined;
            } })(),
            state: () => remote.state({ sessionId }),
            writeCss: cssWriter(sessionId),
        }));
        scoped.effect(() => () => feeds.dispose(), 'message-rewind: feeds');
        const deps = {
            remote,
            sessions: c.sessions,
            conversation: c.conversation,
            feed: sessionId => feeds.peek(sessionId),
        };
        const face = {
            controller: new RewindController(deps),
            t,
            Tooltip: typeof anyPrimitives.Tooltip === 'function' || typeof anyPrimitives.Tooltip === 'object' ? anyPrimitives.Tooltip : undefined,
            RetryIcon: anyPrimitives.IconRefreshOutlineRegular ? anyPrimitives.IconRefreshOutlineRegular : undefined,
        };
        const slots = c.slots;
        const UserNode = createUserNodeRenderer(slots, face, feeds);
        registerUserNodes(slots, UserNode, SHADOW_PRIORITY);
        slots.inject('conversation.chat.assistant-actions', () => slots.register({
            name: 'conversation.chat.assistant-actions', id: 'message-rewind.retry', order: 90,
        }, createRetryAction(face)));
    });
}
