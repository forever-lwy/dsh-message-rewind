/** Chat renderers: the user-message shadow and the retry action. */
import { useEffect, useSyncExternalStore } from 'react'
import { ArmedNotice, RewindButton, UserRewindActions, retryTarget, type RewindFace } from './components.js'
import type { FeedRegistry, SessionFeed } from './feed.js'

export const NODE_SLOT = 'conversation.chat.node'

export interface StoredEntryLike {
  component: unknown
  options: { key?: string; priority?: number }
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

export function createUserNodeRenderer(slots: Pick<SlotsLike, 'entries' | 'subscribe'>, face: RewindFace, feeds?: FeedRegistry) {
  function RewindableUserNode(props: any) {
    const kind: string = props.node?.kind ?? 'user'
    const Official = useSyncExternalStore(
      listener => slots.subscribe(NODE_SLOT, listener),
      () => officialRenderer(slots, kind, RewindableUserNode),
    )
    const subagent = props.useSession?.((state: { subagent?: unknown }) => state.subagent != null) ?? false
    const sessionId: string | undefined = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const feed = useFeed(subagent ? undefined : feeds, sessionId)
    const seq = props.node?.data?.seq
    if (typeof seq === 'number' && sessionId !== undefined && feed) {
      if (feed.armedSeq() === seq) return <div className="dmr-user-row" data-message-rewind-seq={seq}><ArmedNotice sessionId={sessionId} face={face} /></div>
      if (feed.isHidden(seq)) return null
    }
    return <div className="dmr-user-row" data-message-rewind-seq={seq}>
      {Official ? <Official {...props} /> : null}
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
