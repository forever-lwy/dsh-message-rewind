/**
 * Rewind a conversation to one of its user messages, in place.
 *
 * Host half. The Session log is append-only, so a rewind appends one empty
 * system message whose surface replacement shadows the target message and
 * everything after it — the same in-place mechanism `/compact` uses. The
 * marker is appended at the `agent/request` of the step that admits the
 * replacing message, right before that message joins the surface, so the
 * model never sees the withdrawn exchange and nothing is withdrawn until a
 * new message is actually sent.
 *
 * - Edit: `arm` marks the target; the next message the person sends (from the
 *   composer, with the original text and attachments refilled by the client)
 *   replaces it.
 * - Retry: `retry` sends the original message again, reusing its durable
 *   attachment references, and replaces the target with it.
 *
 * Workspace files are not restored. `inspect` reports the file edits recorded
 * after the target so the client can warn before a rewind.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import {
  armSchema, attachmentRequestSchema, remoteInfo, retrySchema, sessionSchema, targetSchema,
  type RewindArmed, type RewindArmResult, type RewindAttachmentData, type RewindAttachmentInfo,
  type RewindInspection, type RewindModified, type RewindRetryResult,
} from './remote.js'

export const name = 'dsh-message-rewind'
export const inject = ['typert', 'attachments', 'agents']

export interface Settings {
  mutatingTools: string[]
  attachmentMaxBytes: number
  stopTimeoutMs: number
}

export const Config: z<Settings> = z.object({
  mutatingTools: z.array(z.string()).default(['write', 'edit']).description('视为修改工作区文件的工具名；回退或重新生成涉及这些工具时弹出警告'),
  attachmentMaxBytes: z.natural().min(1).default(64 * 1024 * 1024).description('回填输入框时单个附件的最大字节数'),
  stopTimeoutMs: z.natural().min(1000).default(20_000).description('回退前等待运行中的任务停止的最长时间（毫秒）'),
}) as never

/** The event fields these reads depend on. */
export interface EventLike {
  type: string
  seq: number
  data?: any
}

/** One content block of a durable user message. */
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: { attachmentId: string; mediaType: string; bytes: number; name?: string } }
  | { type: 'file'; attachment: { attachmentId: string; name: string; bytes: number } }
  | { type: string; [key: string]: unknown }

export interface SessionLike {
  id: string
  seq: number
  surface: { nodes: readonly number[] }
  eventAt(seq: number): EventLike | undefined
  snapshotEvents(from?: number, to?: number): readonly EventLike[]
  append(type: string, data: unknown, options?: unknown): EventLike
}

export interface AgentLike {
  id: string
  status: string
  session: SessionLike
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  followup(message: unknown): void
}

interface MessageLike {
  id?: string
  content?: unknown
  source?: { kind?: unknown; rpcId?: unknown }
}

type Refusal = RewindInspection['refusal']

/** Whether one event is a message the human sent (not runtime context or other injected input). */
export function isHumanMessage(event: EventLike | undefined): boolean {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

function isHumanPrompt(message: MessageLike): boolean {
  return message.source?.kind === 'user' && typeof message.source.rpcId === 'string'
}

function contentOf(event: EventLike | undefined): MessageBlock[] {
  const content = event?.data?.content
  return Array.isArray(content) ? content as MessageBlock[] : []
}

function attachmentsOf(content: readonly MessageBlock[]) {
  return content.filter((block): block is MessageBlock & { type: 'image' | 'file'; attachment: any } =>
    (block.type === 'image' || block.type === 'file') && typeof (block as any).attachment === 'object' && (block as any).attachment !== null)
}

function textOf(content: readonly MessageBlock[]): string {
  return content.filter(block => block.type === 'text' && typeof (block as any).text === 'string').map(block => (block as any).text as string).join('')
}

/**
 * Why `seq` cannot be rewound in place, or null when it can.
 * @param session - the live Session.
 * @param seq - candidate human message.
 */
export function refusalOf(session: SessionLike, seq: number): Refusal {
  const index = session.surface.nodes.indexOf(seq)
  if (index < 0) return 'missing'
  if (index === 0) return 'head'
  return isHumanMessage(session.eventAt(seq)) ? null : 'not-user'
}

/**
 * Workspace edits and human messages recorded after `seq`.
 * @param events - the log from `seq` on.
 * @param seq - target message.
 * @param tools - names of file-editing tools.
 * @param surface - current surface nodes, to count only messages still in context.
 */
export function laterActivity(events: readonly EventLike[], seq: number, tools: readonly string[], surface: readonly number[]): { modified: RewindModified; laterMessages: number } {
  const turns = new Set<unknown>()
  const visible = new Set(surface)
  let edits = 0
  let laterMessages = 0
  for (const event of events) {
    if (event.seq <= seq) continue
    if (event.type === 'workspace/changes') turns.add(event.data?.turn ?? event.seq)
    else if (event.type === 'tool/call' && tools.includes(event.data?.name)) edits++
    else if (isHumanMessage(event) && visible.has(event.seq)) laterMessages++
  }
  return { modified: { turns: turns.size, edits }, laterMessages }
}

/**
 * Shadow `target` and every later surface node with one empty system message.
 * @param session - the live Session, between `agent/request` and the step's input.
 * @param target - human message to withdraw.
 * @param turn - current turn.
 * @param step - current step.
 * @returns the marker event.
 */
export function rewindSurface(session: SessionLike, target: number, turn: number, step: number): EventLike {
  const refusal = refusalOf(session, target)
  if (refusal !== null) throw new Error(`message ${target} cannot be rewound (${refusal})`)
  const nodes = [...session.surface.nodes]
  const shadowed = nodes.slice(nodes.indexOf(target))
  return session.append('system/message', {
    turn,
    step,
    // Empty later system nodes are dormant: they project to no provider message.
    message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [] },
  }, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
    sourceEventSeqs: shadowed,
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context { messageRewind: MessageRewindService }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function refusalText(refusal: NonNullable<Refusal>): string {
  return {
    missing: '这条消息已不在模型上下文中（可能已被压缩），无法回退。',
    head: '会话开头的消息无法回退。',
    'not-user': '只能回退你发送的消息。',
  }[refusal]
}

export class MessageRewindService extends TypertRemoteService {
  /** Edits waiting for the next human message, per live Agent. */
  private readonly armed = new WeakMap<object, RewindArmed>()
  /** Retried messages by id → the target they replace. */
  private readonly retries = new Map<string, number>()
  /** Rewinds to apply at this Agent's next matching `agent/request`. */
  private readonly plans = new WeakMap<object, { turn: number; step: number; target: number }>()
  private readonly inflight = new Set<string>()

  constructor(ctx: Context, private readonly settings: () => Settings) {
    super(ctx, 'messageRewind')
  }

  private lookup(sessionId: string): AgentLike | undefined {
    return (this.ctx as any).agents?.get?.(sessionId) as AgentLike | undefined
  }

  private agent(sessionId: string): AgentLike {
    const agent = this.lookup(sessionId)
    if (agent === undefined) throw new RemoteError('gateway/bad-request', '会话未加载，请重新打开后再试。', {})
    return agent
  }

  private describe(agent: AgentLike, seq: number): RewindInspection {
    const session = agent.session
    const content = contentOf(session.eventAt(seq))
    const limit = this.settings().attachmentMaxBytes
    const attachments: RewindAttachmentInfo[] = attachmentsOf(content).map(block => ({
      kind: block.type,
      name: String(block.attachment.name ?? (block.type === 'image' ? 'image' : 'file')),
      bytes: Number(block.attachment.bytes ?? 0),
      ...(block.type === 'image' ? { mediaType: String(block.attachment.mediaType) } : {}),
      available: Number(block.attachment.bytes ?? 0) <= limit,
    }))
    const activity = laterActivity(session.snapshotEvents(seq), seq, this.settings().mutatingTools, session.surface.nodes)
    return {
      sessionId: session.id, seq, refusal: refusalOf(session, seq),
      text: textOf(content), attachments, ...activity,
      running: agent.status !== 'idle',
    }
  }

  /** Stop a running Agent, discarding its queued input: all of it comes after the target. */
  private async stop(agent: AgentLike): Promise<void> {
    if (agent.status === 'idle') return
    agent.cancel({ kind: 'user' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop-timeout')), this.settings().stopTimeoutMs) }),
      ])
    } catch {
      throw new RemoteError('gateway/bad-request', '当前任务未能及时停止，请稍后再试。', {})
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Stop the Agent, re-check the target, and run `act` unless stopping
   * surfaced workspace edits the person has not been warned about.
   */
  private async prepare<T>(sessionId: string, seq: number, knownModified: boolean, act: (agent: AgentLike) => T): Promise<T | { status: 'confirm'; inspection: RewindInspection }> {
    if (this.inflight.has(sessionId)) throw new RemoteError('gateway/bad-request', '正在处理上一次回退，请稍候。', {})
    this.inflight.add(sessionId)
    try {
      const agent = this.agent(sessionId)
      await this.stop(agent)
      const inspection = this.describe(agent, seq)
      if (inspection.refusal !== null) throw new RemoteError('gateway/bad-request', refusalText(inspection.refusal), {})
      const modified = inspection.modified.turns + inspection.modified.edits > 0
      if (modified && !knownModified) return { status: 'confirm', inspection }
      return act(agent)
    } finally {
      this.inflight.delete(sessionId)
    }
  }

  @Remote
  async inspect(request: unknown, signal: AbortSignal): Promise<RewindInspection> {
    signal.throwIfAborted()
    const parsed = targetSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '回退参数无效。', {})
    return this.describe(this.agent(parsed.data.sessionId), parsed.data.seq)
  }

  @Remote
  async attachment(request: unknown, signal: AbortSignal): Promise<RewindAttachmentData> {
    const parsed = attachmentRequestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '附件参数无效。', {})
    const { sessionId, seq, index } = parsed.data
    const event = this.agent(sessionId).session.eventAt(seq)
    if (!isHumanMessage(event)) throw new RemoteError('gateway/bad-request', '找不到这条用户消息。', {})
    const block = attachmentsOf(contentOf(event))[index]
    if (block === undefined) throw new RemoteError('gateway/bad-request', '附件不存在。', {})
    const limit = this.settings().attachmentMaxBytes
    if (Number(block.attachment.bytes ?? 0) > limit) throw new RemoteError('gateway/bad-request', '附件超过回填大小上限。', {})
    if (block.type === 'image') {
      const stored = await this.ctx.attachments.readImage(block.attachment, signal)
      return { name: block.attachment.name ?? `image-${index + 1}`, mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of this.ctx.attachments.readFileStream(block.attachment, signal)) {
      total += chunk.byteLength
      if (total > limit) throw new RemoteError('gateway/bad-request', '附件超过回填大小上限。', {})
      chunks.push(Buffer.from(chunk))
    }
    return { name: block.attachment.name, mediaType: 'application/octet-stream', data: Buffer.concat(chunks).toString('base64') }
  }

  @Remote
  async arm(request: unknown, signal: AbortSignal): Promise<RewindArmResult> {
    signal.throwIfAborted()
    const parsed = armSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '回退参数无效。', {})
    const { sessionId, seq, knownModified } = parsed.data
    return this.prepare(sessionId, seq, knownModified, agent => {
      const armed = { seq, lastSeq: agent.session.seq - 1 }
      this.armed.set(agent, armed)
      return { status: 'armed' as const, armed }
    })
  }

  @Remote
  async disarm(request: unknown): Promise<{ ok: true }> {
    const parsed = sessionSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '参数无效。', {})
    const agent = this.lookup(parsed.data.sessionId)
    if (agent) this.armed.delete(agent)
    return { ok: true }
  }

  @Remote
  async state(request: unknown): Promise<{ armed: RewindArmed | null }> {
    const parsed = sessionSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '参数无效。', {})
    const agent = this.lookup(parsed.data.sessionId)
    return { armed: (agent && this.armed.get(agent)) ?? null }
  }

  @Remote
  async retry(request: unknown, signal: AbortSignal): Promise<RewindRetryResult> {
    signal.throwIfAborted()
    const parsed = retrySchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '重新生成参数无效。', {})
    const { sessionId, seq, knownModified, note } = parsed.data
    return this.prepare(sessionId, seq, knownModified, agent => {
      const event = agent.session.eventAt(seq)
      const content: MessageBlock[] = [...contentOf(event)]
      if (note) content.push({ type: 'text', text: `\n\n${note}` })
      const source = { ...(event?.data?.source ?? { kind: 'user' }), rpcId: `message-rewind:${randomUUID()}` }
      // The original durable attachment references are reused as they are.
      const message = Object.freeze({ id: randomUUID(), role: 'user', content: structuredClone(content), source })
      this.armed.delete(agent)
      this.retries.set(message.id, seq)
      agent.followup(message)
      return { status: 'sent' as const }
    })
  }

  /** `agent/pre-step`: a step admitting a retried or edited message plans its rewind. */
  claim(agent: AgentLike, messages: readonly MessageLike[], turn: number, step: number): void {
    for (const message of messages) {
      const target = typeof message.id === 'string' ? this.retries.get(message.id) : undefined
      if (target === undefined) continue
      this.retries.delete(message.id!)
      this.plans.set(agent, { turn, step, target })
      return
    }
    const armed = this.armed.get(agent)
    if (armed !== undefined && messages.some(isHumanPrompt)) {
      this.armed.delete(agent)
      this.plans.set(agent, { turn, step, target: armed.seq })
    }
  }

  /** `agent/request`: shadow the withdrawn range before the step's new message is admitted. */
  apply(agent: AgentLike, turn: number, step: number): void {
    const plan = this.plans.get(agent)
    if (plan === undefined || plan.turn !== turn || plan.step !== step) return
    this.plans.delete(agent)
    try {
      rewindSurface(agent.session, plan.target, turn, step)
    } catch (error) {
      // The message still goes out; only the withdrawal is skipped.
      this.ctx.logger.warn('message-rewind: rewinding %s to %d failed: %s', agent.id, plan.target, errorText(error))
    }
  }
}

export function apply(ctx: Context, config: Partial<Settings> = {}): void {
  const settings = () => (Config as unknown as (value: unknown) => Settings)(config)
  ctx.typert.remotes.register(remoteInfo)
  const service = new MessageRewindService(ctx, settings)
  const on = (ctx as any).on.bind(ctx)
  on('agent/pre-step', async (payload: { agent: AgentLike; messages: readonly MessageLike[]; turn: number; step: number }, next: () => Promise<unknown>) => {
    service.claim(payload.agent, payload.messages, payload.turn, payload.step)
    return next()
  })
  on('agent/request', async (payload: { agent: AgentLike; turn: number; step: number }, next: () => Promise<unknown>) => {
    service.apply(payload.agent, payload.turn, payload.step)
    return next()
  })
}
