import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RewindInspection } from '../remote.js'
import type { RewindController, RewindMode, RewindNotice, RewindOptions } from './controller.js'
import { format } from './locales.js'

export type Translate = (key: string) => string

/** What a rewind button needs from the plugin. */
export interface RewindFace {
  controller: RewindController
  t: Translate
  Tooltip?: typeof import('@deepseek-ai/dsh-client-ui-primitives').Tooltip | undefined
  RetryIcon?: (() => ReactNode) | undefined
}

export function UndoIcon() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M5.5 3.5 2.5 6.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 6.5h6.25a4 4 0 0 1 0 8H6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
}

export function RefreshIcon() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M13 3v2.5h-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** Workspace files were edited after the message: cancel, confirm, or confirm and tell the model. */
  | { kind: 'warn'; info: RewindInspection }
  /** Nothing was edited, but the rewind withdraws later turns or stops a running task. */
  | { kind: 'confirm'; info: RewindInspection }
  | { kind: 'working' }
  | { kind: 'error'; message: string }

export const isModified = (info: RewindInspection) => info.modified.turns + info.modified.edits > 0

/** The warning or confirmation lines for one inspection. */
export function describe(info: RewindInspection, mode: RewindMode, t: Translate): { text: string; tone?: 'warn' }[] {
  const lines: { text: string; tone?: 'warn' }[] = []
  if (isModified(info)) {
    const parts = [
      info.modified.turns > 0 ? format(t('modifiedTurns'), { count: info.modified.turns }) : '',
      info.modified.edits > 0 ? format(t('modifiedEdits'), { count: info.modified.edits }) : '',
    ].filter(Boolean).join(t('listSeparator'))
    lines.push({ text: format(t(mode === 'retry' ? 'modifiedRetry' : 'modifiedEdit'), { details: parts }), tone: 'warn' })
  }
  if (info.laterMessages > 0) lines.push({ text: format(t('laterMessages'), { count: info.laterMessages }) })
  else lines.push({ text: t(mode === 'retry' ? 'retryBody' : 'editBody') })
  if (mode === 'edit') {
    const tooLarge = info.attachments.filter(attachment => !attachment.available).length
    if (tooLarge > 0) lines.push({ text: format(t('attachmentsTooLarge'), { count: tooLarge }), tone: 'warn' })
  }
  if (info.running) lines.push({ text: t('running'), tone: 'warn' })
  return lines
}

function noticeText(notice: RewindNotice, t: Translate): string {
  return format(t(notice.key), notice.values)
}

function refusalText(refusal: NonNullable<RewindInspection['refusal']>, t: Translate): string {
  return t(`refusal.${refusal}`)
}

/**
 * One rewind or retry button with its inline confirmation panel.
 * @param props - target message, mode, and the plugin face.
 */
export function RewindButton({ sessionId, seq, mode, face, side = 'bottom', onOpenChange }: {
  sessionId: string
  seq: number
  mode: RewindMode
  face: RewindFace
  side?: 'top' | 'bottom'
  onOpenChange?: (open: boolean) => void
}) {
  const { controller, t } = face
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const open = phase.kind !== 'idle'
  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (phase.kind !== 'warn' && phase.kind !== 'confirm' && phase.kind !== 'error') return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPhase({ kind: 'idle' }) }
    const onPointer = (event: PointerEvent) => {
      if (panel.current && event.target instanceof Node && !panel.current.parentElement?.contains(event.target)) setPhase({ kind: 'idle' })
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer) }
  }, [phase.kind])

  const fail = useCallback((error: unknown) => {
    const message = format(t('failed'), { message: error instanceof Error ? error.message : String(error) })
    if (alive.current) setPhase({ kind: 'error', message })
    else console.warn('[dsh-message-rewind]', message)
  }, [t])

  const act = useCallback((info: RewindInspection, options: RewindOptions) => {
    setPhase({ kind: 'working' })
    controller.run(sessionId, info, mode, options).then(outcome => {
      if (!alive.current) return
      if (outcome.status === 'confirm') setPhase({ kind: 'warn', info: outcome.inspection })
      else if (outcome.notices.length > 0) setPhase({ kind: 'error', message: outcome.notices.map(notice => noticeText(notice, t)).join('\n') })
      else setPhase({ kind: 'idle' })
    }, fail)
  }, [controller, fail, mode, sessionId, t])

  const start = useCallback(() => {
    if (phase.kind !== 'idle') { if (phase.kind !== 'working') setPhase({ kind: 'idle' }); return }
    setPhase({ kind: 'loading' })
    controller.inspect(sessionId, seq).then(info => {
      if (!alive.current) return
      if (info.refusal !== null) setPhase({ kind: 'error', message: refusalText(info.refusal, t) })
      else if (isModified(info)) setPhase({ kind: 'warn', info })
      else if (info.running || (mode === 'retry' && info.laterMessages > 0)) setPhase({ kind: 'confirm', info })
      else act(info, { knownModified: false, note: null })
    }, fail)
  }, [act, controller, fail, mode, phase.kind, sessionId, seq, t])

  const label = t(mode === 'retry' ? 'retry' : 'rewind')
  const button = <button
    type="button"
    className="dmr-action"
    aria-label={label}
    aria-expanded={open}
    data-rewind-mode={mode}
    disabled={phase.kind === 'working'}
    onClick={start}
  >{mode === 'retry' ? (face.RetryIcon ? <face.RetryIcon /> : <RefreshIcon />) : <UndoIcon />}</button>

  const note = t(mode === 'retry' ? 'noteRetry' : 'noteEdit')
  return <span className="dmr-anchor">
    {face.Tooltip && !open ? <face.Tooltip label={label} side="bottom">{button}</face.Tooltip> : button}
    {open && <div className="dmr-panel" data-side={side} role="dialog" aria-label={label} ref={panel} data-phase={phase.kind}>
      {phase.kind === 'loading' && <p>{t('loading')}</p>}
      {phase.kind === 'working' && <p role="status">{t(mode === 'retry' ? 'sending' : 'preparing')}</p>}
      {phase.kind === 'error' && <>
        {phase.message.split('\n').map((line, index) => <p key={index} data-tone="error">{line}</p>)}
        <div className="dmr-buttons"><button type="button" className="dmr-button" onClick={() => setPhase({ kind: 'idle' })}>{t('close')}</button></div>
      </>}
      {(phase.kind === 'warn' || phase.kind === 'confirm') && <>
        <h4>{t(phase.kind === 'warn' ? 'warnTitle' : (mode === 'retry' ? 'retryTitle' : 'rewindTitle'))}</h4>
        {describe(phase.info, mode, t).map((line, index) => <p key={index} data-tone={line.tone}>{line.text}</p>)}
        {phase.kind === 'warn' && <p className="dmr-note">{format(t('noteHint'), { note })}</p>}
        <div className="dmr-buttons">
          <button type="button" className="dmr-button" onClick={() => setPhase({ kind: 'idle' })}>{t('cancel')}</button>
          <button type="button" className="dmr-button" data-primary={phase.kind === 'confirm' ? '' : undefined}
            onClick={() => act(phase.info, { knownModified: true, note: null })}>{t('confirm')}</button>
          {phase.kind === 'warn' && <button type="button" className="dmr-button" data-primary=""
            onClick={() => act(phase.info, { knownModified: true, note })}>{t('confirmWithNote')}</button>}
        </div>
      </>}
    </div>}
  </span>
}

/** The rewind and regenerate row under one user message. */
export function UserRewindActions({ sessionId, seq, face }: { sessionId: string; seq: number; face: RewindFace }) {
  const [editOpen, setEditOpen] = useState(false)
  const [retryOpen, setRetryOpen] = useState(false)
  return <div className="dmr-user-actions" data-open={editOpen || retryOpen || undefined}>
    <RewindButton sessionId={sessionId} seq={seq} mode="retry" face={face} onOpenChange={setRetryOpen} />
    <RewindButton sessionId={sessionId} seq={seq} mode="edit" face={face} onOpenChange={setEditOpen} />
  </div>
}

/** Shown in place of a message whose edit is pending in the composer. */
export function ArmedNotice({ sessionId, face }: { sessionId: string; face: RewindFace }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const undo = () => {
    setBusy(true)
    face.controller.undo(sessionId).then(() => setBusy(false), error => {
      setBusy(false)
      setError(format(face.t('failed'), { message: error instanceof Error ? error.message : String(error) }))
    })
  }
  return <div className="dmr-armed" role="status">
    <span>{face.t('armed')}</span>
    <button type="button" className="dmr-button" disabled={busy} onClick={undo}>{face.t('undoRewind')}</button>
    {error && <span data-tone="error">{error}</span>}
  </div>
}

/** Minimal Chat snapshot surface the retry button reads. */
export interface ChatSnapshotLike {
  timeline?: { turnOrder?: readonly number[]; turns?: { get(turn: number): any } }
  locations?: { getTurn(turn: number): readonly string[] }
  nodes?: { get(key: string): any }
}

/**
 * The latest human message of the last Turn, when `messageId` closes that Turn.
 * @param snapshot - Chat snapshot.
 * @param messageId - assistant message the action strip belongs to.
 * @returns the message seq to regenerate from, or null.
 */
export function retryTarget(snapshot: ChatSnapshotLike, messageId: string): number | null {
  const last = snapshot.timeline?.turnOrder?.at(-1)
  if (last === undefined) return null
  const turn = snapshot.timeline?.turns?.get(last)
  if (turn?.data?.get?.('turn-tail')?.closing?.finalNode?.messageId !== messageId) return null
  const keys = snapshot.locations?.getTurn(last) ?? []
  for (let index = keys.length - 1; index >= 0; index--) {
    const node = snapshot.nodes?.get(keys[index] as string)
    if ((node?.kind === 'user' || node?.kind === 'steering') && typeof node.data?.seq === 'number') return node.data.seq
  }
  return null
}
