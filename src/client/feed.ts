/**
 * Which parts of a transcript a rewind withdrew, and the stylesheet that
 * hides them.
 *
 * The official Chat keeps showing every append-origin event, so a rewound
 * exchange stays on screen unless something hides it. One feed per open
 * Session reads rewind markers from the Session event window — only the
 * entries each change adds, never a rescan per event — and turns their
 * ranges into a single `<style>` scoped to that Session's conversation: whole
 * Turns by `data-chat-turn`, single nodes by `data-chat-node-key` where a
 * rewind starts mid-Turn. Nothing observes the DOM; the stylesheet changes
 * only when a range changes or older history pages in.
 */
import type { RewindArmed } from '../remote.js'

export interface EventLike {
  type: string
  seq: number
  data?: any
  surfaceOp?: unknown
}

/** Half-open event-seq range a rewind withdrew; `keep` stays visible (a pending edit's own message). */
export interface HiddenRange {
  from: number
  to: number
  /** The rewound human message. */
  target: number
  keep?: number
}

interface EntryLike { type: string; event: EventLike }

interface WindowLike {
  entries: readonly EntryLike[]
  revision: number
  change?: { kind: string; entries?: readonly unknown[] }
}

interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The parts of the Chat snapshot the stylesheet reads. */
export interface ChatLike {
  order?: readonly string[]
  nodes?: { values(): Iterable<{ key: string; anchorSeq?: number; data?: any }> }
  timeline?: { turnOrder?: readonly number[] }
  locations?: { getTurn(turn: number): readonly string[] }
}

export function isHumanMessage(event: EventLike | undefined): boolean {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

function replaceOf(event: EventLike): { startSeq: number; endSeq: number } | undefined {
  const op = event.surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown } | undefined
  if (typeof op !== 'object' || op === null || op.op !== 'replace') return undefined
  return typeof op.startSeq === 'number' && typeof op.endSeq === 'number' ? { startSeq: op.startSeq, endSeq: op.endSeq } : undefined
}

/** Markers of this plugin and dsh-redo (empty system message) and of dsh-rewind-plugin. */
function isRewindMarker(event: EventLike): boolean {
  if (event.type === 'system/message') {
    const content = event.data?.message?.content
    return Array.isArray(content) && content.length === 0
  }
  return event.type === 'user/message' && event.data?.source?.kind === 'dsh-rewind'
}

/**
 * Where a withdrawal starts: before the Turn when the message opened it, so
 * the Turn disappears whole, or at the message itself when it was steered in.
 * @param events - the loaded window in seq order.
 * @param index - position of the human message.
 */
export function withdrawalStart(events: readonly EventLike[], index: number): number {
  const target = events[index]!
  for (let at = index - 1; at >= 0; at--) {
    const event = events[at]!
    if (event.type === 'turn/end') break
    if (event.type === 'assistant/message' || isHumanMessage(event)) return target.seq
    if (event.type === 'turn/start') return event.seq
  }
  return target.seq
}

/**
 * The range one marker withdrew, or null when `events[index]` is no rewind.
 * @param events - the loaded window in seq order.
 * @param index - position of a candidate marker.
 */
export function rewindRange(events: readonly EventLike[], index: number): HiddenRange | null {
  const marker = events[index]!
  const op = replaceOf(marker)
  if (op === undefined || !isRewindMarker(marker)) return null
  let targetIndex = -1
  for (let at = index - 1; at >= 0; at--) {
    const seq = events[at]!.seq
    if (seq === op.startSeq) { targetIndex = at; break }
    if (seq < op.startSeq) break
  }
  // System-prompt normalization also empties single system nodes; a rewind always starts at a human message.
  if (targetIndex >= 0 ? !isHumanMessage(events[targetIndex]) : op.startSeq === op.endSeq) return null
  const from = targetIndex >= 0 ? withdrawalStart(events, targetIndex) : op.startSeq
  let to = marker.type === 'user/message' ? marker.seq + 1 : marker.seq
  // The marker opens the replacing Turn; that Turn stays visible.
  const turn = marker.data?.turn
  if (marker.type === 'system/message' && typeof turn === 'number') {
    for (let at = index - 1; at >= 0 && events[at]!.seq > from; at--) {
      const event = events[at]!
      if (event.type === 'turn/start' && event.data?.turn === turn) { to = event.seq; break }
    }
  }
  return { from, to, target: op.startSeq }
}

const inRange = (ranges: readonly HiddenRange[], seq: number | undefined) =>
  typeof seq === 'number' && ranges.some(range => seq >= range.from && seq < range.to)

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`

/**
 * CSS hiding `ranges` inside one Session's conversation.
 * @param sessionId - Session whose conversation root carries `data-conversation-session`.
 * @param ranges - withdrawn ranges.
 * @param turnStarts - Turn number → its `turn/start` seq.
 * @param chat - current Chat snapshot.
 */
export function hidingCss(sessionId: string, ranges: readonly HiddenRange[], turnStarts: ReadonlyMap<number, number>, chat: ChatLike | undefined): string {
  if (ranges.length === 0) return ''
  const scope = `[data-conversation-session=${quote(sessionId)}]`
  const keeps = ranges.flatMap(range => range.keep === undefined ? [] : [range.keep])
  const selectors: string[] = []
  const keysInHiddenTurns = new Set<string>()
  const starts = [...turnStarts].sort((a, b) => a[1] - b[1])
  for (const [index, [turn, start]] of starts.entries()) {
    if (!inRange(ranges, start)) continue
    // A Turn holding a kept message is hidden node by node instead.
    const end = starts[index + 1]?.[1] ?? Infinity
    if (keeps.some(keep => keep >= start && keep < end)) continue
    for (const key of chat?.locations?.getTurn(turn) ?? []) keysInHiddenTurns.add(key)
    selectors.push(`${scope} [data-chat-turn=${quote(String(turn))}]`)
  }
  for (const node of chat?.nodes?.values() ?? []) {
    if (keysInHiddenTurns.has(node.key)) continue
    const seq = node.anchorSeq ?? node.data?.seq
    if (!inRange(ranges, seq) || keeps.includes(node.data?.seq)) continue
    selectors.push(`${scope} [data-chat-node-key=${quote(node.key)}]`)
  }
  return selectors.length === 0 ? '' : `${selectors.join(',\n')} { display: none !important; }\n`
}

export interface FeedDeps {
  events: Observable<WindowLike> | undefined
  chat: Observable<ChatLike | undefined> | undefined
  state?: () => Promise<{ armed: RewindArmed | null }>
  /** Install or replace this Session's stylesheet; empty text removes it. */
  writeCss: (css: string) => void
}

/** Withdrawn ranges and the pending edit of one Session. */
export class SessionFeed {
  private ranges: HiddenRange[] = []
  private readonly turnStarts = new Map<number, number>()
  private armed: (RewindArmed & { from: number }) | null = null
  private revision = 0
  private eventRevision = -1
  private readonly listeners = new Set<() => void>()
  private readonly stops: (() => void)[] = []
  private chatStop: (() => void) | undefined
  private lastOrder: unknown
  private lastCss = ''

  constructor(readonly sessionId: string, private readonly deps: FeedDeps) {
    if (deps.events) {
      this.stops.push(deps.events.subscribe(() => this.read()))
      this.read()
    }
    void deps.state?.().then(({ armed }) => { if (armed && !this.armed) this.setArmed(armed) }, () => {})
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getRevision = () => this.revision

  /** Whether the message at `seq` was withdrawn (or is pending withdrawal). */
  isHidden(seq: number): boolean {
    return inRange(this.visibleRanges(), seq) && this.armed?.seq !== seq
  }

  armedSeq(): number | null {
    return this.armed?.seq ?? null
  }

  /** Mark a pending edit: `armed.seq` through `armed.lastSeq` leave the transcript until it is sent or undone. */
  setArmed(armed: RewindArmed | null): void {
    if (armed === null) this.armed = null
    else {
      const events = this.events()
      const index = events.findIndex(event => event.seq === armed.seq)
      this.armed = { ...armed, from: index >= 0 ? withdrawalStart(events, index) : armed.seq }
    }
    this.changed()
  }

  hiddenRanges(): readonly HiddenRange[] {
    return this.visibleRanges()
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.chatStop?.()
    this.chatStop = undefined
    this.listeners.clear()
    this.deps.writeCss('')
  }

  private visibleRanges(): HiddenRange[] {
    return this.armed === null ? this.ranges
      : [...this.ranges, { from: this.armed.from, to: this.armed.lastSeq + 1, target: this.armed.seq, keep: this.armed.seq }]
  }

  private events(): EventLike[] {
    const entries = this.deps.events?.getSnapshot().entries ?? []
    const events: EventLike[] = []
    for (const entry of entries) if (entry.type === 'event') events.push(entry.event)
    return events
  }

  /** Scan only the entries the latest change added. */
  private read(): void {
    const window = this.deps.events!.getSnapshot()
    if (window.revision === this.eventRevision) return
    this.eventRevision = window.revision
    const kind = window.change?.kind
    if (kind === 'settle-assistant') return
    const entries = window.entries
    const added = window.change?.entries?.length ?? entries.length
    let start = 0
    let end = entries.length
    // Older history paging in may hold nodes of a known range.
    let found = kind !== 'append' && this.visibleRanges().length > 0
    if (kind === 'append') start = Math.max(0, entries.length - added)
    else if (kind === 'prepend') end = Math.min(entries.length, added)
    else { this.ranges = []; this.turnStarts.clear() }
    let events: EventLike[] | undefined
    for (let index = start; index < end; index++) {
      const entry = entries[index]!
      if (entry.type !== 'event') continue
      const event = entry.event
      if (event.type === 'turn/start' && typeof event.data?.turn === 'number') this.turnStarts.set(event.data.turn, event.seq)
      if (replaceOf(event) === undefined) continue
      events ??= this.events()
      const at = events.findIndex(candidate => candidate.seq === event.seq)
      const range = at >= 0 ? rewindRange(events, at) : null
      if (range === null) continue
      this.ranges.push(range)
      if (this.armed?.seq === range.target) this.armed = null
      found = true
    }
    if (found) this.changed()
  }

  private changed(): void {
    this.revision++
    const ranges = this.visibleRanges()
    if (ranges.length > 0 && this.chatStop === undefined && this.deps.chat) {
      this.chatStop = this.deps.chat.subscribe(() => {
        const order = this.deps.chat!.getSnapshot()?.order
        if (order !== this.lastOrder) this.restyle()
      })
    } else if (ranges.length === 0 && this.chatStop !== undefined) {
      this.chatStop()
      this.chatStop = undefined
    }
    this.restyle()
    for (const listener of [...this.listeners]) listener()
  }

  private restyle(): void {
    const chat = this.deps.chat?.getSnapshot()
    this.lastOrder = chat?.order
    const css = hidingCss(this.sessionId, this.visibleRanges(), this.turnStarts, chat)
    if (css === this.lastCss) return
    this.lastCss = css
    this.deps.writeCss(css)
  }
}

/** Reference-counted feeds, one per Session shown in a conversation. */
export class FeedRegistry {
  private readonly feeds = new Map<string, { feed: SessionFeed; users: number; timer?: ReturnType<typeof setTimeout> }>()

  constructor(private readonly create: (sessionId: string) => SessionFeed, private readonly graceMs = 600_000) {}

  peek(sessionId: string): SessionFeed | undefined {
    return this.feeds.get(sessionId)?.feed
  }

  /** The feed for `sessionId`, created on first use; unheld, it lapses after the grace period. */
  ensure(sessionId: string): SessionFeed {
    const existing = this.feeds.get(sessionId)
    if (existing !== undefined) return existing.feed
    const slot = { feed: this.create(sessionId), users: 0 }
    this.feeds.set(sessionId, slot)
    this.schedule(sessionId, slot)
    return slot.feed
  }

  acquire(sessionId: string): SessionFeed {
    this.ensure(sessionId)
    const slot = this.feeds.get(sessionId)!
    if (slot.timer !== undefined) { clearTimeout(slot.timer); slot.timer = undefined }
    slot.users++
    return slot.feed
  }

  /** Rows mount and unmount as the transcript pages; a feed outlives a short gap. */
  release(sessionId: string): void {
    const slot = this.feeds.get(sessionId)
    if (slot === undefined || --slot.users > 0) return
    this.schedule(sessionId, slot)
  }

  private schedule(sessionId: string, slot: { feed: SessionFeed; users: number; timer?: ReturnType<typeof setTimeout> }): void {
    slot.timer = setTimeout(() => {
      if (slot.users > 0) return
      this.feeds.delete(sessionId)
      slot.feed.dispose()
    }, this.graceMs)
    ;(slot.timer as { unref?: () => void }).unref?.()
  }

  dispose(): void {
    for (const slot of this.feeds.values()) { clearTimeout(slot.timer); slot.feed.dispose() }
    this.feeds.clear()
  }
}
