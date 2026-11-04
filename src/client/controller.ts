/**
 * Browser-side rewind steps over the public Client services.
 *
 * - Edit: read the message's attachments back, arm the Host (which stops a
 *   running task first), then put the text and attachments into the composer.
 *   The next send replaces the message.
 * - Retry: ask the Host to send the original message again in place.
 */
import type { RewindAttachmentData, RewindInspection, RewindRemote } from '../remote.js'
import type { SessionFeed } from './feed.js'

export type RewindMode = 'edit' | 'retry'

/** A failure or notice surfaced to the person after the operation. */
export interface RewindNotice {
  key: string
  values?: Record<string, string | number>
}

export interface RewindOptions {
  /** The person already saw the workspace-edit warning. */
  knownModified: boolean
  /** Sentence appended to the message telling the model the workspace was not rewound. */
  note: string | null
}

export type RewindOutcome =
  | { status: 'done'; notices: RewindNotice[] }
  /** Stopping the task surfaced edits not shown yet; nothing changed. */
  | { status: 'confirm'; inspection: RewindInspection }

interface SessionInputLike {
  setDraft(text: string): void
  addAttachments(ids: readonly string[]): boolean
  focus?(): void
}

/** The Client services the steps use, narrowed for tests. */
export interface RewindDeps {
  remote: RewindRemote
  sessions: {
    list: { getSnapshot(): { byId: Record<string, { running?: boolean } | undefined> } }
    scope(id: string): unknown
  }
  conversation: {
    input: { for(actx: unknown): SessionInputLike }
    createDrafts(sessionId: string, files: readonly File[]): readonly { id: string }[]
  }
  feed(sessionId: string): SessionFeed | undefined
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

function decode(data: RewindAttachmentData, kind: 'image' | 'file'): File {
  const binary = atob(data.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], data.name, { type: kind === 'image' ? data.mediaType : (data.mediaType === 'application/octet-stream' ? '' : data.mediaType) })
}

export class RewindController {
  /** One rewind at a time per Session. */
  private readonly busy = new Set<string>()

  constructor(private readonly deps: RewindDeps) {}

  isRunning(sessionId: string): boolean {
    return this.deps.sessions.list.getSnapshot().byId[sessionId]?.running === true
  }

  inspect(sessionId: string, seq: number): Promise<RewindInspection> {
    return this.deps.remote.inspect({ sessionId, seq })
  }

  /**
   * Rewind `sessionId` to just before message `info.seq`.
   * @param sessionId - Session to rewind.
   * @param info - inspection returned by {@link inspect}.
   * @param mode - edit returns the message to the composer; retry sends it again.
   * @param options - warning acknowledgement and the optional note.
   */
  async run(sessionId: string, info: RewindInspection, mode: RewindMode, options: RewindOptions): Promise<RewindOutcome> {
    if (this.busy.has(sessionId)) throw new Error('rewind already in progress')
    this.busy.add(sessionId)
    try {
      return mode === 'retry' ? await this.retry(sessionId, info, options) : await this.edit(sessionId, info, options)
    } finally {
      this.busy.delete(sessionId)
    }
  }

  /** Withdraw a pending edit; the transcript shows the message again. */
  async undo(sessionId: string): Promise<void> {
    await this.deps.remote.disarm({ sessionId })
    this.deps.feed(sessionId)?.setArmed(null)
  }

  private async retry(sessionId: string, info: RewindInspection, options: RewindOptions): Promise<RewindOutcome> {
    const result = await this.deps.remote.retry({ sessionId, seq: info.seq, knownModified: options.knownModified, note: options.note })
    return result.status === 'confirm' ? result : { status: 'done', notices: [] }
  }

  private async edit(sessionId: string, info: RewindInspection, options: RewindOptions): Promise<RewindOutcome> {
    const { remote, sessions, conversation } = this.deps
    const notices: RewindNotice[] = []
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
    const result = await remote.arm({ sessionId, seq: info.seq, knownModified: options.knownModified })
    if (result.status === 'confirm') return result
    this.deps.feed(sessionId)?.setArmed(result.armed)
    const scope = sessions.scope(sessionId)
    if (scope === undefined) throw new Error('session not open')
    const input = conversation.input.for(scope)
    input.setDraft(options.note ? `${info.text}\n\n${options.note}` : info.text)
    const drafts = files.length > 0 ? conversation.createDrafts(sessionId, files) : []
    if (drafts.length > 0 && !input.addAttachments(drafts.map(draft => draft.id))) {
      notices.push({ key: 'attachmentFailed', values: { name: files.map(file => file.name).join(', '), message: 'composer refused' } })
    }
    input.focus?.()
    return { status: 'done', notices }
  }
}
