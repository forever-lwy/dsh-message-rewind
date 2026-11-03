/** Chat renderers: the user-message shadow and the retry action. */
import { useSyncExternalStore } from 'react'
import { RewindButton, UserRewindActions, retryTarget, type RewindFace } from './components.js'

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

export function createUserNodeRenderer(slots: Pick<SlotsLike, 'entries' | 'subscribe'>, face: RewindFace) {
  function RewindableUserNode(props: any) {
    const kind: string = props.node?.kind ?? 'user'
    const Official = useSyncExternalStore(
      listener => slots.subscribe(NODE_SLOT, listener),
      () => officialRenderer(slots, kind, RewindableUserNode),
    )
    const subagent = props.useSession?.((state: { subagent?: unknown }) => state.subagent != null) ?? false
    const seq = props.node?.data?.seq
    return <div className="dmr-user-row" data-message-rewind-seq={seq}>
      {Official ? <Official {...props} /> : null}
      {!subagent && typeof seq === 'number' && typeof props.sessionId === 'string'
        ? <UserRewindActions sessionId={props.sessionId} seq={seq} face={face} />
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
