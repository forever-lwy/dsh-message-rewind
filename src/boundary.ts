/**
 * Pure reads over a Session event log: which `user/message` events a human
 * wrote, where a fork must cut to put the conversation back to the moment
 * before one of them, and which queued messages that cut would inherit.
 */

/** The event fields these reads depend on. */
export interface EventLike {
  type: string
  seq: number
  data?: unknown
}

/** One content block of a durable user message. */
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: { attachmentId: string; mediaType: string; bytes: number; width?: number; height?: number; name?: string } }
  | { type: 'file'; attachment: { attachmentId: string; name: string; bytes: number } }
  | { type: string; [key: string]: unknown }

interface UserMessageData {
  id?: string
  content?: unknown
  source?: { kind?: unknown }
}

/**
 * Whether one event is a message the human typed (not runtime context, time
 * context, compaction checkpoints, or other injected `user/message` events).
 * @param event - any Session event.
 */
export function isHumanMessage(event: EventLike): boolean {
  if (event.type !== 'user/message') return false
  const data = event.data as UserMessageData | undefined
  return data?.source?.kind === 'user'
}

/** The content blocks of one human message, or an empty list. */
export function messageContent(event: EventLike): MessageBlock[] {
  const content = (event.data as UserMessageData | undefined)?.content
  return Array.isArray(content) ? content as MessageBlock[] : []
}

/**
 * The inclusive seq a fork keeps so the child stands just before `seq`.
 *
 * For the message that opened its turn, the cut lands before that turn's
 * `turn/start` and before the inbox splices that delivered the message, so
 * the child ends on a closed turn. For a message steered into a running turn
 * the cut is the event right before it; the Host closes that turn with
 * synthetic `forked` closers.
 *
 * @param events - the log from seq 0 through at least `seq`.
 * @param seq - the human message's seq.
 * @returns the boundary seq, or null when nothing precedes the message (a
 *   fresh Session replaces the fork).
 */
export function forkBoundary(events: readonly EventLike[], seq: number): number | null {
  let start = -1
  let steering = false
  for (let index = seq - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') break
    if (event.type === 'assistant/message' || isHumanMessage(event)) steering = true
    if (event.type === 'turn/start') { start = index; break }
  }
  if (start < 0 || steering) return seq - 1 >= 0 ? seq - 1 : null
  let boundary = start - 1
  while (boundary >= 0 && events[boundary]?.type.startsWith('agent/inbox/')) boundary--
  return boundary >= 0 ? boundary : null
}

interface InboxSplice {
  target?: unknown
  start?: unknown
  removedCount?: unknown
  inserted?: unknown
}

/**
 * Replay inbox splices through `boundary` and list the message ids still
 * queued there. A fork at that boundary inherits them; the rewind removes
 * them so a stale queued message never rides along with the edited one.
 * @param events - the log from seq 0 through at least `boundary`.
 * @param boundary - inclusive fork boundary.
 * @returns ids of the inherited pending messages, next-turn first.
 */
export function pendingInboxIds(events: readonly EventLike[], boundary: number): string[] {
  const inbox: Record<string, unknown[]> = { 'next-turn': [], 'next-step': [] }
  for (let index = 0; index <= boundary && index < events.length; index++) {
    const event = events[index]
    if (event?.type !== 'agent/inbox/spliced') continue
    const splice = event.data as InboxSplice
    const target = typeof splice.target === 'string' ? splice.target : 'next-turn'
    const list = inbox[target] ?? (inbox[target] = [])
    const start = typeof splice.start === 'number' ? splice.start : 0
    const removed = typeof splice.removedCount === 'number' ? splice.removedCount : 0
    const inserted = Array.isArray(splice.inserted) ? splice.inserted : []
    list.splice(start, removed, ...inserted)
  }
  const ids: string[] = []
  for (const target of ['next-turn', 'next-step', ...Object.keys(inbox).filter(key => key !== 'next-turn' && key !== 'next-step')]) {
    for (const message of inbox[target] ?? []) {
      const id = (message as { id?: unknown })?.id
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}
