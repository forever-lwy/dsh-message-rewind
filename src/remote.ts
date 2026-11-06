/** Typert Remote contract shared by the Host service and the browser client. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

const sessionId = z.string().min(1).max(200)
const seq = z.number().int().nonnegative()

export const targetSchema = z.object({ sessionId, seq }).strict()
export type RewindTarget = z.infer<typeof targetSchema>
export const sessionSchema = z.object({ sessionId }).strict()

const attachmentSchema = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  /** Whether the Host will serve the bytes (within the transfer limit). */
  available: z.boolean(),
})
export type RewindAttachmentInfo = z.infer<typeof attachmentSchema>

/** Workspace edits recorded after the target message; rewinding does not undo them. */
const modifiedSchema = z.object({
  /** Turns the built-in recorder reported changed files for (`workspace/changes`). */
  turns: z.number().int().nonnegative(),
  /** Calls of file-editing tools (`write`, `edit`, ...). */
  edits: z.number().int().nonnegative(),
})
export type RewindModified = z.infer<typeof modifiedSchema>

export const inspectionSchema = z.object({
  sessionId: z.string(),
  seq,
  /** Why the message cannot be rewound; null when it can. */
  refusal: z.enum(['missing', 'head', 'not-user']).nullable(),
  text: z.string(),
  attachments: z.array(attachmentSchema),
  modified: modifiedSchema,
  /** Later human messages the rewind withdraws. */
  laterMessages: z.number().int().nonnegative(),
  running: z.boolean(),
})
export type RewindInspection = z.infer<typeof inspectionSchema>

export const attachmentRequestSchema = z.object({ sessionId, seq, index: z.number().int().nonnegative() }).strict()
export const attachmentDataSchema = z.object({ name: z.string(), mediaType: z.string(), data: z.string() })
export type RewindAttachmentData = z.infer<typeof attachmentDataSchema>

/** `knownModified`: the person already saw a warning listing workspace edits. */
export const armSchema = z.object({ sessionId, seq, knownModified: z.boolean() }).strict()
export const retrySchema = z.object({ sessionId, seq, knownModified: z.boolean(), note: z.string().max(2000).nullable() }).strict()

/** A pending edit: the next human message replaces `seq` and everything after it, up to `lastSeq` at arming. */
const armedSchema = z.object({ seq, lastSeq: seq })
export type RewindArmed = z.infer<typeof armedSchema>

/** Stopping the task surfaced edits the person has not seen; nothing changed. */
const confirmSchema = z.object({ status: z.literal('confirm'), inspection: inspectionSchema })
export const armResultSchema = z.union([z.object({ status: z.literal('armed'), armed: armedSchema }), confirmSchema])
export type RewindArmResult = z.infer<typeof armResultSchema>
export const retryResultSchema = z.union([z.object({ status: z.literal('sent') }), confirmSchema])
export type RewindRetryResult = z.infer<typeof retryResultSchema>
export const stateSchema = z.object({ armed: armedSchema.nullable() })
const ok = z.object({ ok: z.literal(true) })

const codec = (schema: z.ZodType, typeSymbol: string) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })
const method = (input: z.ZodType, output: z.ZodType) => ({
  service: 'messageRewind', invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', source: 'json' as const, codec: codec(input, 'MessageRewindRequest'), strictCodec: codec(input, 'MessageRewindRequest') }],
  result: codec(output, 'MessageRewindResult'), cancellation: { parameter: 'signal' as const },
})

export const remoteInfo = createTypertRemoteInfo({ package: '@forever-lwy/dsh-message-rewind', methods: {
  'messageRewind/inspect': method(targetSchema, inspectionSchema),
  'messageRewind/attachment': method(attachmentRequestSchema, attachmentDataSchema),
  'messageRewind/arm': method(armSchema, armResultSchema),
  'messageRewind/disarm': method(sessionSchema, ok),
  'messageRewind/retry': method(retrySchema, retryResultSchema),
  'messageRewind/state': method(sessionSchema, stateSchema),
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
  arm(request: RewindTarget & { knownModified: boolean }, signal?: AbortSignal): Promise<RewindArmResult>
  disarm(request: { sessionId: string }, signal?: AbortSignal): Promise<{ ok: true }>
  retry(request: RewindTarget & { knownModified: boolean; note: string | null }, signal?: AbortSignal): Promise<RewindRetryResult>
  state(request: { sessionId: string }, signal?: AbortSignal): Promise<{ armed: RewindArmed | null }>
}

export function bindRemote(remote: unknown): RewindRemote {
  return {
    inspect: (target, signal) => invoke(remote, 'messageRewind/inspect', target, signal),
    attachment: (request, signal) => invoke(remote, 'messageRewind/attachment', request, signal),
    arm: (request, signal) => invoke(remote, 'messageRewind/arm', request, signal),
    disarm: (request, signal) => invoke(remote, 'messageRewind/disarm', request, signal),
    retry: (request, signal) => invoke(remote, 'messageRewind/retry', request, signal),
    state: (request, signal) => invoke(remote, 'messageRewind/state', request, signal),
  }
}
