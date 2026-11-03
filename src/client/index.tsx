/**
 * Browser half: a rewind button under every durable user message and a
 * regenerate button in the latest reply's action strip.
 *
 * rc.5 offers no action slot on user messages, so this plugin shadows the
 * official `user`/`steering` Chat Node renderers at a lower priority and
 * renders the current official renderer unchanged above its own row; the
 * official entry is looked up at render time, so it follows HMR and stays the
 * owner of the bubble itself.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { bindRemote, remoteInfo } from '../remote.js'
import { RewindController, type RewindDeps } from './controller.js'
import type { RewindFace } from './components.js'
import { NODE_SLOT, createRetryAction, createUserNodeRenderer, type SlotsLike } from './renderers.js'
import { en, zh } from './locales.js'
import { styles } from './styles.js'

export const name = 'dsh-message-rewind-client'
export const inject = ['slots', 'locale', 'remote']

const PACKAGE = 'dsh-message-rewind'
const namespace = 'messageRewind'
/** Below the official renderer's default priority 0, so this entry wins its cell. */
const SHADOW_PRIORITY = -10

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A rewind preparing its forked Session's composer. */
    messageRewind: unknown
  }
}

export { RewindController } from './controller.js'
export { RewindButton, UserRewindActions, retryTarget } from './components.js'
export { createRetryAction, createUserNodeRenderer, officialRenderer } from './renderers.js'

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

  ctx.inject(['remote.messageRewind', 'sessions', 'conversation', 'uiWorkspace'], (scoped: Context) => {
    const c = scoped as any
    const deps: RewindDeps = {
      remote: bindRemote(c.remote),
      sessions: c.sessions,
      conversation: c.conversation,
      openSession: id => c.uiWorkspace.openSession(id),
      archiveSession: id => {
        const workspaces = scoped.get('workspaces') as { archiveSession?: (id: string, options: { stopActivity: boolean }) => Promise<void> } | undefined
        return workspaces?.archiveSession ? workspaces.archiveSession(id, { stopActivity: true }) : Promise.resolve()
      },
    }
    const face: RewindFace = {
      controller: new RewindController(deps),
      t,
      Tooltip: typeof anyPrimitives.Tooltip === 'function' || typeof anyPrimitives.Tooltip === 'object' ? anyPrimitives.Tooltip as RewindFace['Tooltip'] : undefined,
      RetryIcon: anyPrimitives.IconRefreshOutlineRegular ? anyPrimitives.IconRefreshOutlineRegular as RewindFace['RetryIcon'] : undefined,
    }
    const slots = c.slots as SlotsLike
    const UserNode = createUserNodeRenderer(slots, face)
    for (const key of ['user', 'steering']) {
      slots.inject(NODE_SLOT, () => slots.register({ name: NODE_SLOT, key, locale: 'chat', priority: SHADOW_PRIORITY }, UserNode))
    }
    slots.inject('conversation.chat.assistant-actions', () => slots.register({
      name: 'conversation.chat.assistant-actions', id: 'message-rewind.retry', order: 90,
    }, createRetryAction(face)))
  })
}
