/** Chat renderers: the user-message shadow and the retry action. */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { ArmedNotice, RewindButton, UserRewindActions, retryTarget, type RewindFace } from './components.js'
import type { FeedRegistry, SessionFeed } from './feed.js'

export const NODE_SLOT = 'conversation.chat.node'
/** Official chain the `user` bubble renders above its content (liveshare's origin line, for one). */
export const USER_BEFORE_SLOT = 'conversation.chat.user.before'
/**
 * This plugin's copy of {@link USER_BEFORE_SLOT}. The renderer hands
 * `renderSlotChain` only to an entry that declares a chain child, and only
 * for its own children; the official renderer declared the original, so the
 * shadow declares this copy and keeps it in sync.
 */
export const USER_BEFORE_MIRROR = 'dsh-message-rewind.user.before'

export interface StoredEntryLike {
  component: unknown
  options: { key?: string; priority?: number }
  select?: unknown
  inject?: unknown
  locale?: string
  store?: unknown
  registrant?: string
}
export interface SlotsLike {
  entries(key: string): readonly StoredEntryLike[]
  subscribe(key: string, fn: () => void): () => void
  inject(key: string, fn: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/**
 * Pick the renderer this plugin shadows: the lowest-priority other entry for `key`.
 * @param slots - slot registry.
 * @param key - Chat Node kind.
 * @param self - this plugin's component.
 */
export function officialRenderer(slots: Pick<SlotsLike, 'entries'>, key: string, self: unknown): ((props: any) => any) | undefined {
  let chosen: StoredEntryLike | undefined
  for (const entry of slots.entries(NODE_SLOT)) {
    if (entry.options.key !== key || entry.component === self) continue
    if (chosen === undefined || (entry.options.priority ?? 0) < (chosen.options.priority ?? 0)) chosen = entry
  }
  return chosen?.component as ((props: any) => any) | undefined
}

const noFeed = { subscribe: () => () => {}, getRevision: () => 0 }

/** Hold this Session's feed while the row is mounted and re-render when its ranges change. */
function useFeed(feeds: FeedRegistry | undefined, sessionId: string | undefined): SessionFeed | undefined {
  const feed = sessionId === undefined ? undefined : feeds?.ensure(sessionId)
  useEffect(() => {
    if (sessionId === undefined || feeds === undefined) return
    feeds.acquire(sessionId)
    return () => feeds.release(sessionId)
  }, [feeds, sessionId])
  useSyncExternalStore(feed?.subscribe ?? noFeed.subscribe, feed?.getRevision ?? noFeed.getRevision)
  return feed
}

type RenderSlotChain = (key: string, owner: unknown, options?: { fallback?: ReactNode }) => ReactNode

/**
 * The `renderSlotChain` the official renderer gets through the shadow: the
 * shadow's own binding with {@link USER_BEFORE_SLOT} routed to the mirror, or
 * the fallback when the entry received none.
 * @param own - `renderSlotChain` the renderer gave the shadow entry, if any.
 */
export function officialChain(own: unknown): RenderSlotChain {
  if (typeof own !== 'function') return (_key, _owner, options) => options?.fallback ?? null
  const render = own as RenderSlotChain
  return (key, owner, options) => render(key === USER_BEFORE_SLOT ? USER_BEFORE_MIRROR : key, owner, options)
}

/**
 * Copy every entry of {@link USER_BEFORE_SLOT} into {@link USER_BEFORE_MIRROR},
 * in ledger order, until the returned disposer runs. Start it while the
 * mirror is declared.
 * @param slots - slot registry.
 * @param onError - a copy that failed to register; the chain renders without it.
 */
export function mirrorUserBefore(slots: Pick<SlotsLike, 'entries' | 'subscribe' | 'register'>, onError?: (error: unknown) => void): () => void {
  let copied: readonly StoredEntryLike[] = []
  let disposers: (() => void)[] = []
  let disposed = false
  const clear = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose() } catch { /* already gone */ } } }
  const sync = () => {
    if (disposed) return
    const source = slots.entries(USER_BEFORE_SLOT)
    if (source.length === copied.length && source.every((entry, index) => entry === copied[index])) return
    // Election takes the first match in ledger order; re-registering all keeps that order.
    clear()
    copied = source
    for (const entry of source) {
      if (typeof entry.select !== 'function') continue
      const options: Record<string, unknown> = { name: USER_BEFORE_MIRROR, select: entry.select }
      if (entry.options.priority !== undefined) options.priority = entry.options.priority
      if (entry.inject !== undefined) options.inject = entry.inject
      if (entry.locale !== undefined) options.locale = entry.locale
      if (entry.store !== undefined) options.store = entry.store
      if (entry.registrant !== undefined) options.registrant = entry.registrant
      try { disposers.push(slots.register(options, entry.component)) } catch (error) { onError?.(error) }
    }
  }
  const unsubscribe = slots.subscribe(USER_BEFORE_SLOT, sync)
  sync()
  return () => { disposed = true; unsubscribe(); clear(); disposers = []; copied = [] }
}

/**
 * Register the `user`/`steering` shadows and the chain mirror. Each call to
 * `slots.inject` follows its slot's declaration lifetime.
 * @param slots - slot registry of the plugin's fiber.
 * @param component - the shadow from {@link createUserNodeRenderer}.
 * @param priority - below the official entries' priority.
 */
export function registerUserNodes(slots: SlotsLike, component: unknown, priority: number): void {
  slots.inject(NODE_SLOT, () => slots.register({
    name: NODE_SLOT, key: 'user', locale: 'chat', priority,
    children: { [USER_BEFORE_MIRROR]: { kind: 'chain', scope: 'session' } },
  }, component))
  // The official steering entry renders no chain either.
  slots.inject(NODE_SLOT, () => slots.register({
    name: NODE_SLOT, key: 'steering', locale: 'chat', priority,
    inject: () => ({ renderSlotChain: () => null }),
  }, component))
  slots.inject(USER_BEFORE_MIRROR, () => mirrorUserBefore(slots, error => console.warn('[dsh-message-rewind] user.before mirror:', error)))
}

export function createUserNodeRenderer(slots: Pick<SlotsLike, 'entries' | 'subscribe'>, face: RewindFace, feeds?: FeedRegistry) {
  function RewindableUserNode(props: any) {
    const kind: string = props.node?.kind ?? 'user'
    const Official = useSyncExternalStore(
      listener => slots.subscribe(NODE_SLOT, listener),
      () => officialRenderer(slots, kind, RewindableUserNode),
    )
    // The official bubble calls renderSlotChain unconditionally; a throw here retires this shadow for the page.
    const renderSlotChain = useMemo(() => officialChain(props.renderSlotChain), [props.renderSlotChain])
    const subagent = props.useSession?.((state: { subagent?: unknown }) => state.subagent != null) ?? false
    const sessionId: string | undefined = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const feed = useFeed(subagent ? undefined : feeds, sessionId)
    const seq = props.node?.data?.seq
    if (typeof seq === 'number' && sessionId !== undefined && feed) {
      if (feed.armedSeq() === seq) return <div className="dmr-user-row" data-message-rewind-seq={seq}><ArmedNotice sessionId={sessionId} face={face} /></div>
      if (feed.isHidden(seq)) return null
    }
    return <div className="dmr-user-row" data-message-rewind-seq={seq}>
      {Official ? <Official {...props} renderSlotChain={renderSlotChain} /> : null}
      {!subagent && typeof seq === 'number' && sessionId !== undefined
        ? <UserRewindActions sessionId={sessionId} seq={seq} face={face} />
        : null}
    </div>
  }
  return RewindableUserNode
}

export function createRetryAction(face: RewindFace) {
  return function RetryAction(props: any) {
    const seq: number | null = props.useChat?.((snapshot: any) => retryTarget(snapshot, props.messageId)) ?? null
    const running: boolean = props.useSession?.((state: { running?: boolean }) => state.running === true) ?? false
    const subagent: boolean = props.useSession?.((state: { subagent?: unknown }) => state.subagent != null) ?? false
    if (seq === null || running || subagent || typeof props.sessionId !== 'string') return null
    return <RewindButton sessionId={props.sessionId} seq={seq} mode="retry" face={face} side="top" />
  }
}
