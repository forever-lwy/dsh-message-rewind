/** Typert Remote contract shared by the Host service and the browser client. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

const sessionId = z.string().min(1).max(200)
const seq = z.number().int().nonnegative()

export const targetSchema = z.object({ sessionId, seq }).strict()
export type RewindTarget = z.infer<typeof targetSchema>

const attachmentSchema = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  /** Whether the Host will serve the bytes (within the transfer limit). */
  available: z.boolean(),
})
export type RewindAttachmentInfo = z.infer<typeof attachmentSchema>

const checkpointSchema = z.object({
  createdAt: z.number(),
  files: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** Session whose recording holds the checkpoint (a fork source for inherited messages). */
  ownerSessionId: z.string(),
})

export const inspectionSchema = z.object({
  sessionId: z.string(),
  seq,
  /** Inclusive fork boundary; null when a fresh Session replaces the fork. */
  boundary: z.number().int().nonnegative().nullable(),
  /** Queued messages the fork would inherit and the rewind removes. */
  inheritedQueue: z.array(z.string()),
  text: z.string(),
  attachments: z.array(attachmentSchema),
  checkpoint: checkpointSchema.nullable(),
  cwd: z.string().nullable(),
  agentPreset: z.string().nullable(),
  /** Host settings the client follows. */
  settings: z.object({ restoreFiles: z.boolean(), archiveSource: z.boolean() }),
})
export type RewindInspection = z.infer<typeof inspectionSchema>

export const attachmentRequestSchema = z.object({ sessionId, seq, index: z.number().int().nonnegative() }).strict()
export const attachmentDataSchema = z.object({ name: z.string(), mediaType: z.string(), data: z.string() })
export type RewindAttachmentData = z.infer<typeof attachmentDataSchema>

export const restoreResultSchema = z.object({
  restored: z.boolean(),
  written: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  failed: z.array(z.string()),
  /** Checkpoint of the files just before the restore; `undo` puts them back. */
  backupId: z.string().nullable(),
})
export type RewindRestoreResult = z.infer<typeof restoreResultSchema>

export const undoSchema = z.object({ sessionId, backupId: z.string().regex(/^backup-[0-9a-z-]+$/) }).strict()
export const linkSchema = z.object({ childId: sessionId, sourceId: sessionId, boundary: z.number().int().nonnegative().nullable() }).strict()
const ok = z.object({ ok: z.literal(true) })

const codec = (schema: z.ZodType, typeSymbol: string) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })
const method = (input: z.ZodType, output: z.ZodType) => ({
  service: 'messageRewind', invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', source: 'json' as const, codec: codec(input, 'MessageRewindRequest'), strictCodec: codec(input, 'MessageRewindRequest') }],
  result: codec(output, 'MessageRewindResult'), cancellation: { parameter: 'signal' as const },
})

export const remoteInfo = createTypertRemoteInfo({ package: 'dsh-message-rewind', methods: {
  'messageRewind/inspect': method(targetSchema, inspectionSchema),
  'messageRewind/attachment': method(attachmentRequestSchema, attachmentDataSchema),
  'messageRewind/restore': method(targetSchema, restoreResultSchema),
  'messageRewind/undo': method(undoSchema, restoreResultSchema),
  'messageRewind/link': method(linkSchema, ok),
} }, z)

async function invoke<T>(remote: unknown, key: string, request: unknown, signal?: AbortSignal): Promise<T> {
  const result = await (remoteInfo.methods as any)[key].invoke(remote, { request }, signal)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Browser-side calls bound to one mounted remote. */
export interface RewindRemote {
  inspect(target: RewindTarget, signal?: AbortSignal): Promise<RewindInspection>
  attachment(request: RewindTarget & { index: number }, signal?: AbortSignal): Promise<RewindAttachmentData>
  restore(target: RewindTarget, signal?: AbortSignal): Promise<RewindRestoreResult>
  undo(request: { sessionId: string; backupId: string }, signal?: AbortSignal): Promise<RewindRestoreResult>
  link(request: { childId: string; sourceId: string; boundary: number | null }, signal?: AbortSignal): Promise<{ ok: true }>
}

export function bindRemote(remote: unknown): RewindRemote {
  return {
    inspect: (target, signal) => invoke(remote, 'messageRewind/inspect', target, signal),
    attachment: (request, signal) => invoke(remote, 'messageRewind/attachment', request, signal),
    restore: (target, signal) => invoke(remote, 'messageRewind/restore', target, signal),
    undo: (request, signal) => invoke(remote, 'messageRewind/undo', request, signal),
    link: (request, signal) => invoke(remote, 'messageRewind/link', request, signal),
  }
}
