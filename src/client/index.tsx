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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { bindRemote, remoteInfo } from '../remote.js'
import { RewindController, type RewindDeps } from './controller.js'
import type { RewindFace } from './components.js'
import { FeedRegistry, SessionFeed } from './feed.js'
import { createRetryAction, createUserNodeRenderer, registerUserNodes, type SlotsLike } from './renderers.js'
import { en, zh } from './locales.js'
import { styles } from './styles.js'

export const name = 'dsh-message-rewind-client'
export const inject = ['slots', 'locale', 'remote']

const PACKAGE = '@forever-lwy/dsh-message-rewind'
const namespace = 'messageRewind'
/** Below the official renderer's default priority 0, so this entry wins its cell. */
const SHADOW_PRIORITY = -10

export { RewindController } from './controller.js'
export { ArmedNotice, RewindButton, UserRewindActions, describe, retryTarget } from './components.js'
export { FeedRegistry, SessionFeed, hidingCss, rewindRange, withdrawalStart } from './feed.js'
export { createRetryAction, createUserNodeRenderer, mirrorUserBefore, officialChain, officialRenderer, registerUserNodes } from './renderers.js'

/** One `<style>` per Session holding its hiding rules. */
function cssWriter(sessionId: string): (css: string) => void {
  let node: HTMLStyleElement | undefined
  return css => {
    if (css === '') { node?.remove(); node = undefined; return }
    if (node === undefined) {
      node = document.createElement('style')
      node.dataset.plugin = `${PACKAGE}-hidden`
      node.dataset.session = sessionId
      document.head.appendChild(node)
    }
    node.textContent = css
  }
}

export async function apply(ctx: Context): Promise<void> {
  const unmount = await (ctx as any).remote.$mount(remoteInfo)
  ctx.effect(() => unmount, 'message-rewind: remote schema')
  ctx.effect(() => ctx.locale.register(namespace, 'zh', zh), 'message-rewind: Chinese')
  ctx.effect(() => ctx.locale.register(namespace, 'en', en), 'message-rewind: English')
  ctx.effect(() => {
    const node = document.createElement('style')
    node.dataset.plugin = PACKAGE
    node.textContent = styles
    document.head.appendChild(node)
    return () => node.remove()
  }, 'message-rewind: styles')
  const t = ctx.locale.bind(namespace) as unknown as (key: string) => string
  const anyPrimitives = primitives as Record<string, unknown>

  ctx.inject(['remote.messageRewind', 'sessions', 'conversation', 'uiConversation'], (scoped: Context) => {
    const c = scoped as any
    const remote = bindRemote(c.remote)
    const feeds = new FeedRegistry(sessionId => new SessionFeed(sessionId, {
      events: c.sessions.binding(sessionId)?.eventSource,
      chat: (() => { try { return c.uiConversation.binding(sessionId).target('chat') } catch { return undefined } })(),
      state: () => remote.state({ sessionId }),
      writeCss: cssWriter(sessionId),
    }))
    scoped.effect(() => () => feeds.dispose(), 'message-rewind: feeds')
    const deps: RewindDeps = {
      remote,
      sessions: c.sessions,
      conversation: c.conversation,
      feed: sessionId => feeds.peek(sessionId),
    }
    const face: RewindFace = {
      controller: new RewindController(deps),
      t,
      Tooltip: typeof anyPrimitives.Tooltip === 'function' || typeof anyPrimitives.Tooltip === 'object' ? anyPrimitives.Tooltip as RewindFace['Tooltip'] : undefined,
      RetryIcon: anyPrimitives.IconRefreshOutlineRegular ? anyPrimitives.IconRefreshOutlineRegular as RewindFace['RetryIcon'] : undefined,
    }
    const slots = c.slots as SlotsLike
    const UserNode = createUserNodeRenderer(slots, face, feeds)
    registerUserNodes(slots, UserNode, SHADOW_PRIORITY)
    slots.inject('conversation.chat.assistant-actions', () => slots.register({
      name: 'conversation.chat.assistant-actions', id: 'message-rewind.retry', order: 90,
    }, createRetryAction(face)))
  })
}
