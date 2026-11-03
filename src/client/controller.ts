/**
 * Browser-side rewind choreography over the public Client services:
 * stop the source, restore files, fork (or start fresh), drop inherited
 * queued messages, return the message to the composer, open the child,
 * archive the source, and — for a retry — send the message again.
 */
import type { RewindAttachmentData, RewindInspection, RewindRemote } from '../remote.js'

export type RewindMode = 'edit' | 'retry'
export type RewindStep = 'stopping' | 'restoring' | 'forking' | 'preparing' | 'sending'

/** A failure or notice surfaced to the person after the operation. */
export interface RewindNotice {
  key: string
  values?: Record<string, string | number>
}

export interface RewindOutcome {
  childId: string
  notices: RewindNotice[]
}

/** The Client services the choreography uses, narrowed for tests. */
export interface RewindDeps {
  remote: RewindRemote
  sessions: {
    list: { getSnapshot(): { byId: Record<string, { running?: boolean; cwd?: string } | undefined> } }
    fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
    create(opts: { cwd?: string; agentPreset?: string }): Promise<string>
    retain(id: string, options: { source: string }): { ready: Promise<unknown>; binding: unknown; release(): void }
    scope(id: string): any
  }
  conversation: {
    input: {
      for(actx: unknown): { setDraft(text: string): void; addAttachments(ids: readonly string[]): boolean; submit(): void }
      requestDraftInitialization(binding: unknown, options: { prompt?: string; whenDraftExists?: 'replace' | 'append' | 'keep' }): string
    }
    createDrafts(sessionId: string, files: readonly File[]): readonly { id: string; kind: string }[]
    fileUploads: { getSnapshot(): Record<string, { status: string } | undefined> }
  }
  openSession(id: string): void
  archiveSession?: (id: string) => Promise<void>
  /** Overridable timing for tests. */
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

function decode(data: RewindAttachmentData, kind: 'image' | 'file'): File {
  const binary = atob(data.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], data.name, { type: kind === 'image' ? data.mediaType : (data.mediaType === 'application/octet-stream' ? '' : data.mediaType) })
}

export class RewindController {
  private readonly wait: (ms: number) => Promise<void>
  private readonly now: () => number
  /** One rewind at a time per source Session. */
  private readonly busy = new Set<string>()

  constructor(private readonly deps: RewindDeps) {
    this.wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = deps.now ?? Date.now
  }

  isRunning(sessionId: string): boolean {
    return this.deps.sessions.list.getSnapshot().byId[sessionId]?.running === true
  }

  inspect(sessionId: string, seq: number): Promise<RewindInspection> {
    return this.deps.remote.inspect({ sessionId, seq })
  }

  private async until(check: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (!check()) {
      if (this.now() >= deadline) return false
      await this.wait(stepMs)
    }
    return true
  }

  /**
   * Rewind `sessionId` to just before message `seq`.
   * @param sessionId - source Session.
   * @param info - inspection returned by {@link inspect}.
   * @param mode - edit returns the message to the composer; retry sends it again.
   * @param onStep - progress callback.
   * @returns the child Session and any non-fatal notices.
   */
  async run(sessionId: string, info: RewindInspection, mode: RewindMode, onStep: (step: RewindStep) => void = () => {}): Promise<RewindOutcome> {
    if (this.busy.has(sessionId)) throw new Error('rewind already in progress')
    this.busy.add(sessionId)
    try {
      return await this.perform(sessionId, info, mode, onStep)
    } finally {
      this.busy.delete(sessionId)
    }
  }

  private async perform(sessionId: string, info: RewindInspection, mode: RewindMode, onStep: (step: RewindStep) => void): Promise<RewindOutcome> {
    const { remote, sessions, conversation } = this.deps
    const notices: RewindNotice[] = []

    if (this.isRunning(sessionId)) {
      onStep('stopping')
      await sessions.scope(sessionId)?.conversation?.cancel?.()
      if (!await this.until(() => !this.isRunning(sessionId), 20_000)) throw new Error('stop-timeout')
    }

    // Read attachments before anything changes, so a failure here aborts cleanly.
    const files: File[] = []
    for (const [index, attachment] of info.attachments.entries()) {
      if (!attachment.available) { notices.push({ key: 'attachmentFailed', values: { name: attachment.name, message: 'too large' } }); continue }
      try {
        files.push(decode(await remote.attachment({ sessionId, seq: info.seq, index }), attachment.kind))
      } catch (error) {
        notices.push({ key: 'attachmentFailed', values: { name: attachment.name, message: errorMessage(error) } })
      }
    }

    let backupId: string | null = null
    if (info.settings.restoreFiles && info.checkpoint !== null) {
      onStep('restoring')
      const restored = await remote.restore({ sessionId, seq: info.seq })
      backupId = restored.backupId
      if (restored.restored) notices.push({ key: 'restoredFiles', values: { written: restored.written, deleted: restored.deleted } })
      if (restored.failed.length > 0) {
        notices.push({ key: 'restoreFailed', values: { count: restored.failed.length, paths: restored.failed.slice(0, 5).join(', ') } })
      }
    }

    onStep('forking')
    let childId: string
    try {
      childId = info.boundary === null
        ? await sessions.create({
          ...(info.cwd === null ? {} : { cwd: info.cwd }),
          ...(info.agentPreset === null ? {} : { agentPreset: info.agentPreset }),
        })
        : await sessions.fork({ sessionId, atSeq: info.boundary, increaseTitle: false })
    } catch (error) {
      if (backupId !== null) {
        await remote.undo({ sessionId, backupId }).then(() => notices.push({ key: 'undone' }), () => {})
      }
      throw error
    }
    await remote.link({ childId, sourceId: sessionId, boundary: info.boundary }).catch(() => {})

    onStep('preparing')
    const reference = sessions.retain(childId, { source: 'messageRewind' })
    let released = false
    const release = () => { if (!released) { released = true; reference.release() } }
    try {
      await reference.ready
      const scope = sessions.scope(childId)
      for (const id of info.inheritedQueue) {
        await scope?.conversation?.updateQueue?.(id, { kind: 'remove' })?.catch?.(() => {})
      }
      conversation.input.requestDraftInitialization(reference.binding, { prompt: info.text, whenDraftExists: 'replace' })
      const input = scope === undefined ? undefined : conversation.input.for(scope)
      const drafts = files.length > 0 ? conversation.createDrafts(childId, files) : []
      if (drafts.length > 0) input?.addAttachments(drafts.map(draft => draft.id))
      this.deps.openSession(childId)

      if (info.settings.archiveSource && this.deps.archiveSession) {
        await this.deps.archiveSession(sessionId).catch(error => notices.push({ key: 'archiveFailed', values: { message: errorMessage(error) } }))
      }

      if (mode === 'retry' && input !== undefined) {
        onStep('sending')
        const fileIds = drafts.filter(draft => draft.kind === 'file').map(draft => draft.id)
        await this.until(() => fileIds.every(id => {
          const status = conversation.fileUploads.getSnapshot()[id]?.status
          return status === 'ready' || status === 'failed'
        }), 300_000, 300)
        input.submit()
      }
    } finally {
      // Navigation holds its own reference once the child is open.
      void this.wait(5_000).then(release)
    }
    return { childId, notices }
  }
}
