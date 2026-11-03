/**
 * Rewind a conversation to one of its user messages.
 *
 * Host half. Before the agent acts on each message a human sends (an opening
 * message or one steered into a running turn), the plugin copies the Session
 * working directory into a content-addressed checkpoint and records where a
 * fork has to cut to stand just before that message. Tool execution waits
 * until the checkpoint is written, so no tool can change a file first.
 *
 * The browser half forks the conversation at the recorded cut, asks this
 * service to put the files back, archives the source, and returns the
 * message (text, images, files) to the composer — or sends it again for a
 * regenerated reply. Every restore first checkpoints the current files, so it
 * can be undone.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { forkBoundary, isHumanMessage, messageContent, pendingInboxIds, type EventLike, type MessageBlock } from './boundary.js'
import { CheckpointStore, sanitizeManifest, type CheckpointLimits, type CheckpointManifest } from './checkpoint.js'
import {
  attachmentRequestSchema, linkSchema, remoteInfo, targetSchema, undoSchema,
  type RewindAttachmentData, type RewindAttachmentInfo, type RewindInspection, type RewindRestoreResult,
} from './remote.js'

export { forkBoundary, isHumanMessage, pendingInboxIds } from './boundary.js'
export { CheckpointStore, walk } from './checkpoint.js'

export const name = 'dsh-message-rewind'
export const inject = ['typert', 'attachments']

export interface Settings {
  enabled: boolean
  restoreFiles: boolean
  archiveSource: boolean
  maxFileBytes: number
  maxFiles: number
  excludeDirs: string[]
  gitignore: boolean
  retentionDays: number
  attachmentMaxBytes: number
  snapshotTimeoutMs: number
}

export const Config: z<Settings> = z.object({
  enabled: z.boolean().default(true).description('发送消息时记录工作区检查点'),
  restoreFiles: z.boolean().default(true).description('回退时恢复工作区文件'),
  archiveSource: z.boolean().default(true).description('回退后归档原会话'),
  maxFileBytes: z.natural().min(1).default(20 * 1024 * 1024).description('单个文件超过此字节数时不记录、不恢复'),
  maxFiles: z.natural().min(1).default(20000).description('每个检查点最多记录的文件数'),
  excludeDirs: z.array(z.string()).default(['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo']).description('任意层级下不记录的目录名（.git 始终排除）'),
  gitignore: z.boolean().default(true).description('遵循 .gitignore'),
  retentionDays: z.natural().min(1).default(30).description('检查点保留天数'),
  attachmentMaxBytes: z.natural().min(1).default(64 * 1024 * 1024).description('回填输入框时单个附件的最大字节数'),
  snapshotTimeoutMs: z.natural().min(1000).default(30_000).description('单次检查点最长耗时（毫秒）；超时后工具照常执行，这条消息不恢复文件'),
}) as never

/** One recorded user message: its checkpoint and the facts a rewind needs. */
interface MessageRecord {
  version: 1
  sessionId: string
  seq: number
  messageId: string | null
  createdAt: number
  boundary: number | null
  inheritedQueue: string[]
  content: MessageBlock[]
  cwd: string
  agentPreset: string | null
  /** Hash of the checkpoint manifest blob; null when recording was disabled or failed. */
  tree: string | null
  files: number
  skipped: number
  truncated: boolean
}

interface Lineage {
  [childId: string]: { sourceId: string; boundary: number | null; linkedAt: number }
}

interface SessionLike {
  id: string
  header: { cwd?: string; origin?: string; delegationDepth?: number; agentPreset?: string }
  snapshotEvents?: (from?: number, to?: number) => readonly EventLike[]
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/

/** The working directory of a top-level Session; subagents share their parent's checkpoints. */
function eligible(session: SessionLike): string | undefined {
  const { cwd, origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

function readEvents(session: SessionLike | undefined, toExclusive?: number): readonly EventLike[] | undefined {
  try { return session?.snapshotEvents?.(0, toExclusive) } catch { return undefined }
}

function attachmentsOf(content: readonly MessageBlock[]) {
  return content.filter((block): block is Extract<MessageBlock, { type: 'image' | 'file' }> & { attachment: any } =>
    (block.type === 'image' || block.type === 'file') && typeof (block as any).attachment === 'object' && (block as any).attachment !== null)
}

function textOf(content: readonly MessageBlock[]): string {
  return content.filter(block => block.type === 'text' && typeof (block as any).text === 'string').map(block => (block as any).text as string).join('')
}

declare module '@deepseek-ai/cordis' {
  interface Context { messageRewind: MessageRewindService }
}

export class MessageRewindService extends TypertRemoteService {
  readonly store: CheckpointStore
  private readonly pending = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private lineageWrite: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, private readonly settings: () => Settings, readonly directory: string) {
    super(ctx, 'messageRewind')
    this.store = new CheckpointStore(directory)
  }

  limits(): CheckpointLimits {
    const settings = this.settings()
    return {
      maxFileBytes: settings.maxFileBytes,
      maxFiles: settings.maxFiles,
      excludeDirs: settings.excludeDirs,
      gitignore: settings.gitignore,
      excludePaths: [this.directory, process.env.DSH_HOME || join(homedir(), '.dsh')],
    }
  }

  private sessionDir(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new RemoteError('gateway/bad-request', '会话标识无效。', {})
    return join(this.directory, 'sessions', sessionId)
  }

  private recordPath(sessionId: string, seq: number): string {
    return join(this.sessionDir(sessionId), `m-${seq}.json`)
  }

  /** Serialize work on one key (a working directory). */
  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    const tail = next.catch(() => {})
    this.locks.set(key, tail)
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key) })
    return next
  }

  /** Resolves once this Session's queued checkpoints are written. */
  settled(sessionId: string): Promise<void> {
    return this.pending.get(sessionId) ?? Promise.resolve()
  }

  /**
   * Queue the checkpoint for one human message just appended to `session`.
   * @param session - the live Session.
   * @param event - its `user/message` event.
   */
  record(session: SessionLike, event: EventLike): void {
    const cwd = eligible(session)
    if (cwd === undefined || !SAFE_ID.test(session.id)) return
    const events = readEvents(session, event.seq + 1)
    const boundary = events ? forkBoundary(events, event.seq) : (event.seq > 0 ? event.seq - 1 : null)
    const inheritedQueue = events && boundary !== null ? pendingInboxIds(events, boundary) : []
    const settings = this.settings()
    const base: MessageRecord = {
      version: 1,
      sessionId: session.id,
      seq: event.seq,
      messageId: typeof (event.data as any)?.id === 'string' ? (event.data as any).id : null,
      createdAt: Date.now(),
      boundary,
      inheritedQueue,
      content: messageContent(event),
      cwd: resolve(cwd),
      agentPreset: session.header.agentPreset ?? null,
      tree: null, files: 0, skipped: 0, truncated: false,
    }
    const previous = this.pending.get(session.id) ?? Promise.resolve()
    const work = previous.then(async () => {
      let record = base
      if (settings.enabled) {
        try {
          const manifest = await this.exclusive(base.cwd, () => this.store.snapshot(base.cwd, this.limits(), AbortSignal.timeout(settings.snapshotTimeoutMs)))
          const { cwd: _cwd, createdAt: _createdAt, ...tree } = manifest
          record = { ...base, tree: await this.store.putJson(tree), files: Object.keys(manifest.entries).length, skipped: manifest.skipped.length, truncated: manifest.truncated }
        } catch (error) {
          this.ctx.logger.warn('message-rewind: checkpoint of %s failed: %s', base.cwd, error instanceof Error ? error.message : String(error))
        }
      }
      await this.store.writeJson(this.recordPath(session.id, event.seq), record)
    }).catch(error => {
      this.ctx.logger.warn('message-rewind: recording message %d of %s failed: %s', event.seq, session.id, error instanceof Error ? error.message : String(error))
    })
    this.pending.set(session.id, work)
    void work.then(() => { if (this.pending.get(session.id) === work) this.pending.delete(session.id) })
  }

  private async readLineage(): Promise<Lineage> {
    try { return JSON.parse(await readFile(join(this.directory, 'lineage.json'), 'utf8')) as Lineage } catch { return {} }
  }

  /** The record for `seq` in `sessionId`, following fork lineage for inherited messages. */
  private async findRecord(sessionId: string, seq: number): Promise<MessageRecord | undefined> {
    await this.settled(sessionId)
    const lineage = await this.readLineage()
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      visited.add(current)
      try {
        const record = JSON.parse(await readFile(this.recordPath(current, seq), 'utf8')) as MessageRecord
        if (record.version === 1 && record.seq === seq) return record
      } catch { /* Not recorded here. */ }
      const link = lineage[current]
      if (link === undefined || link.boundary === null || seq > link.boundary) return undefined
      current = link.sourceId
    }
    return undefined
  }

  private liveSession(sessionId: string): SessionLike | undefined {
    try { return (this.ctx.get('sessions') as { get?: (id: string) => SessionLike | undefined } | undefined)?.get?.(sessionId) } catch { return undefined }
  }

  /** The record, or one derived from the live log when the message predates this plugin. */
  private async resolveTarget(sessionId: string, seq: number): Promise<MessageRecord> {
    const recorded = await this.findRecord(sessionId, seq)
    if (recorded) return recorded
    const session = this.liveSession(sessionId)
    const events = readEvents(session, seq + 1)
    const event = events?.[seq]
    if (!session || !events || !event || !isHumanMessage(event)) {
      throw new RemoteError('gateway/bad-request', '找不到这条用户消息的记录；请重新打开会话后再试。', {})
    }
    const boundary = forkBoundary(events, seq)
    return {
      version: 1, sessionId, seq, messageId: (event.data as any)?.id ?? null, createdAt: Date.now(),
      boundary, inheritedQueue: boundary === null ? [] : pendingInboxIds(events, boundary),
      content: messageContent(event), cwd: session.header.cwd ? resolve(session.header.cwd) : '',
      agentPreset: session.header.agentPreset ?? null, tree: null, files: 0, skipped: 0, truncated: false,
    }
  }

  private async manifestOf(record: MessageRecord): Promise<CheckpointManifest> {
    if (record.tree === null) throw new RemoteError('gateway/bad-request', '这条消息没有文件检查点。', {})
    const tree = await this.store.readJson<Omit<CheckpointManifest, 'cwd' | 'createdAt'>>(record.tree)
    return sanitizeManifest({ ...tree, version: 1, cwd: record.cwd, createdAt: record.createdAt })
  }

  private async restoreManifest(sessionId: string, manifest: CheckpointManifest): Promise<RewindRestoreResult> {
    try {
      if (!(await stat(manifest.cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new RemoteError('gateway/bad-request', `工作目录不存在：${manifest.cwd}`, {})
    }
    return this.exclusive(manifest.cwd, async () => {
      const limits = this.limits()
      const before = await this.store.snapshot(manifest.cwd, limits)
      const { cwd: _cwd, createdAt: _createdAt, ...tree } = before
      const backupId = `backup-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
      await this.store.writeJson(join(this.sessionDir(sessionId), `${backupId}.json`), {
        version: 1, kind: 'backup', cwd: before.cwd, createdAt: before.createdAt, tree: await this.store.putJson(tree),
      })
      const result = await this.store.restore(manifest, limits)
      this.ctx.logger.info('message-rewind: restored %s (%d written, %d deleted, %d failed)', manifest.cwd, result.written, result.deleted, result.failed.length)
      return { restored: true, ...result, backupId }
    })
  }

  @Remote
  async inspect(request: unknown, signal: AbortSignal): Promise<RewindInspection> {
    signal.throwIfAborted()
    const parsed = targetSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '回退参数无效。', {})
    const { sessionId, seq } = parsed.data
    const record = await this.resolveTarget(sessionId, seq)
    const settings = this.settings()
    const attachments: RewindAttachmentInfo[] = attachmentsOf(record.content).map(block => ({
      kind: block.type as 'image' | 'file',
      name: String(block.attachment.name ?? (block.type === 'image' ? 'image' : 'file')),
      bytes: Number(block.attachment.bytes ?? 0),
      ...(block.type === 'image' ? { mediaType: String(block.attachment.mediaType) } : {}),
      available: Number(block.attachment.bytes ?? 0) <= settings.attachmentMaxBytes,
    }))
    return {
      sessionId, seq,
      boundary: record.boundary,
      inheritedQueue: record.inheritedQueue,
      text: textOf(record.content),
      attachments,
      checkpoint: record.tree === null ? null : {
        createdAt: record.createdAt, files: record.files, skipped: record.skipped, truncated: record.truncated, ownerSessionId: record.sessionId,
      },
      cwd: record.cwd || null,
      agentPreset: record.agentPreset,
      settings: { restoreFiles: settings.restoreFiles, archiveSource: settings.archiveSource },
    }
  }

  @Remote
  async attachment(request: unknown, signal: AbortSignal): Promise<RewindAttachmentData> {
    const parsed = attachmentRequestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '附件参数无效。', {})
    const { sessionId, seq, index } = parsed.data
    const record = await this.resolveTarget(sessionId, seq)
    const block = attachmentsOf(record.content)[index]
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
  async restore(request: unknown, signal: AbortSignal): Promise<RewindRestoreResult> {
    signal.throwIfAborted()
    const parsed = targetSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '回退参数无效。', {})
    const { sessionId, seq } = parsed.data
    if (!this.settings().restoreFiles) return { restored: false, written: 0, deleted: 0, unchanged: 0, failed: [], backupId: null }
    const record = await this.resolveTarget(sessionId, seq)
    if (record.tree === null) return { restored: false, written: 0, deleted: 0, unchanged: 0, failed: [], backupId: null }
    return this.restoreManifest(sessionId, await this.manifestOf(record))
  }

  @Remote
  async undo(request: unknown, signal: AbortSignal): Promise<RewindRestoreResult> {
    signal.throwIfAborted()
    const parsed = undoSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '撤销参数无效。', {})
    const { sessionId, backupId } = parsed.data
    let backup: { cwd: string; createdAt: number; tree: string }
    try { backup = JSON.parse(await readFile(join(this.sessionDir(sessionId), `${backupId}.json`), 'utf8')) } catch {
      throw new RemoteError('gateway/bad-request', '找不到回退前的文件备份。', {})
    }
    const tree = await this.store.readJson<Omit<CheckpointManifest, 'cwd' | 'createdAt'>>(backup.tree)
    return this.restoreManifest(sessionId, sanitizeManifest({ ...tree, version: 1, cwd: backup.cwd, createdAt: backup.createdAt }))
  }

  @Remote
  async link(request: unknown, signal: AbortSignal): Promise<{ ok: true }> {
    signal.throwIfAborted()
    const parsed = linkSchema.safeParse(request)
    if (!parsed.success || !SAFE_ID.test(parsed.data.childId) || !SAFE_ID.test(parsed.data.sourceId)) {
      throw new RemoteError('gateway/bad-request', '会话关联参数无效。', {})
    }
    const { childId, sourceId, boundary } = parsed.data
    const write = this.lineageWrite.catch(() => {}).then(async () => {
      const lineage = await this.readLineage()
      lineage[childId] = { sourceId, boundary, linkedAt: Date.now() }
      await this.store.writeJson(join(this.directory, 'lineage.json'), lineage)
    })
    this.lineageWrite = write
    await write
    return { ok: true }
  }

  /**
   * Remove checkpoints of Sessions idle longer than the retention period and
   * every blob no remaining record references.
   * @returns removed Session directories and blobs.
   */
  async collect(now = Date.now()): Promise<{ sessions: number; objects: number }> {
    const cutoff = now - this.settings().retentionDays * 86_400_000
    const root = join(this.directory, 'sessions')
    const referenced = new Set<string>()
    let sessions = 0
    let names: string[] = []
    try { names = await readdir(root) } catch { /* Nothing recorded yet. */ }
    for (const name of names) {
      const dir = join(root, name)
      let files: string[]
      try { files = await readdir(dir) } catch { continue }
      let newest = 0
      for (const file of files) {
        try { newest = Math.max(newest, (await stat(join(dir, file))).mtimeMs) } catch { /* Raced removal. */ }
      }
      if (newest < cutoff) { await rm(dir, { recursive: true, force: true }); sessions++; continue }
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const tree = (JSON.parse(await readFile(join(dir, file), 'utf8')) as { tree?: unknown }).tree
          if (typeof tree !== 'string') continue
          referenced.add(tree)
          const manifest = await this.store.readJson<{ entries?: Record<string, { kind: string; hash?: string }> }>(tree)
          for (const entry of Object.values(manifest.entries ?? {})) if (entry.kind === 'file' && entry.hash) referenced.add(entry.hash)
        } catch { /* An unreadable record keeps nothing alive. */ }
      }
    }
    // Writers in flight may have stored blobs their record does not list yet.
    if (this.pending.size > 0 || this.locks.size > 0) return { sessions, objects: 0 }
    const objects = await this.store.sweep(referenced)
    const lineage = await this.readLineage()
    let changed = false
    for (const [child, link] of Object.entries(lineage)) {
      if (link.linkedAt < cutoff) { delete lineage[child]; changed = true }
    }
    if (changed) await this.store.writeJson(join(this.directory, 'lineage.json'), lineage)
    return { sessions, objects }
  }
}

export function apply(ctx: Context, config: Partial<Settings> = {}): void {
  const settings = () => (Config as unknown as (value: unknown) => Settings)(config)
  // Persistent beside other plugin storages: `data/.dsh/storages` in this deployment.
  const directory = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-message-rewind')
  ctx.typert.remotes.register(remoteInfo)
  const service = new MessageRewindService(ctx, settings, directory)
  void mkdir(directory, { recursive: true }).catch(() => {})

  ctx.on('session/event', (session: any, event: any) => {
    if (isHumanMessage(event)) service.record(session as SessionLike, event as EventLike)
  })

  // Tools run only after the message's checkpoint exists.
  ;(ctx as any).on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
    const id = exec?.agent?.session?.id
    if (typeof id === 'string') await service.settled(id)
    return next()
  })

  const collect = () => {
    void service.collect().then(({ sessions, objects }) => {
      if (sessions || objects) ctx.logger.info('message-rewind: removed %d expired session checkpoints and %d blobs', sessions, objects)
    }).catch(error => ctx.logger.warn('message-rewind: cleanup failed: %s', error instanceof Error ? error.message : String(error)))
  }
  const first = setTimeout(collect, 60_000)
  const daily = setInterval(collect, 86_400_000)
  first.unref?.()
  daily.unref?.()
  ctx.effect(() => () => { clearTimeout(first); clearInterval(daily) }, 'message-rewind: cleanup timers')
}
