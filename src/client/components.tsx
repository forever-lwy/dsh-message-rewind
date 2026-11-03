import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RewindInspection } from '../remote.js'
import type { RewindController, RewindMode, RewindNotice, RewindStep } from './controller.js'
import { format } from './locales.js'

export type Translate = (key: string) => string

/** What a rewind button needs from the plugin. */
export interface RewindFace {
  controller: RewindController
  t: Translate
  Tooltip?: ((props: { label: string; side?: string; children: ReactNode }) => ReactNode) | undefined
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
  | { kind: 'confirm'; info: RewindInspection; running: boolean }
  | { kind: 'working'; step: RewindStep }
  | { kind: 'error'; message: string }

const STEP_KEYS: Record<RewindStep, string> = {
  stopping: 'stopping', restoring: 'restoring', forking: 'forking', preparing: 'preparing', sending: 'sending',
}

function describe(info: RewindInspection, running: boolean, mode: RewindMode, t: Translate): { text: string; tone?: 'warn' }[] {
  const lines: { text: string; tone?: 'warn' }[] = [{ text: t(mode === 'retry' ? 'retryBody' : 'rewindBody') }]
  if (!info.settings.restoreFiles) lines.push({ text: t('filesOff') })
  else if (info.checkpoint === null) lines.push({ text: t('noCheckpoint'), tone: 'warn' })
  else {
    lines.push({ text: format(t('files'), { files: info.checkpoint.files }) })
    if (info.checkpoint.truncated) lines.push({ text: t('truncated'), tone: 'warn' })
    if (info.checkpoint.skipped > 0) lines.push({ text: format(t('skipped'), { count: info.checkpoint.skipped }), tone: 'warn' })
  }
  const tooLarge = info.attachments.filter(attachment => !attachment.available).length
  if (tooLarge > 0) lines.push({ text: format(t('attachmentsTooLarge'), { count: tooLarge }), tone: 'warn' })
  if (running) lines.push({ text: t('running'), tone: 'warn' })
  lines.push({ text: t(info.settings.archiveSource ? 'archive' : 'keepSource') })
  return lines
}

function noticeText(notice: RewindNotice, t: Translate): string {
  return format(t(notice.key), notice.values)
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
    if (phase.kind !== 'confirm' && phase.kind !== 'error') return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPhase({ kind: 'idle' }) }
    const onPointer = (event: PointerEvent) => {
      if (panel.current && event.target instanceof Node && !panel.current.parentElement?.contains(event.target)) setPhase({ kind: 'idle' })
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer) }
  }, [phase.kind])

  const start = useCallback(() => {
    if (phase.kind !== 'idle') { if (phase.kind !== 'working') setPhase({ kind: 'idle' }); return }
    setPhase({ kind: 'loading' })
    controller.inspect(sessionId, seq).then(info => {
      if (alive.current) setPhase({ kind: 'confirm', info, running: controller.isRunning(sessionId) })
    }, error => {
      if (alive.current) setPhase({ kind: 'error', message: format(t('failed'), { message: error instanceof Error ? error.message : String(error) }) })
    })
  }, [controller, phase.kind, sessionId, seq, t])

  const confirm = useCallback((info: RewindInspection) => {
    setPhase({ kind: 'working', step: 'forking' })
    controller.run(sessionId, info, mode, step => { if (alive.current) setPhase({ kind: 'working', step }) }).then(outcome => {
      const problems = outcome.notices.filter(notice => notice.key !== 'restoredFiles')
      if (!alive.current) {
        if (problems.length > 0) console.warn('[dsh-message-rewind]', problems.map(notice => noticeText(notice, t)).join('\n'))
        return
      }
      if (problems.length > 0) setPhase({ kind: 'error', message: problems.map(notice => noticeText(notice, t)).join('\n') })
      else setPhase({ kind: 'idle' })
    }, error => {
      const message = error instanceof Error && error.message === 'stop-timeout' ? t('stopTimeout')
        : format(t('failed'), { message: error instanceof Error ? error.message : String(error) })
      if (alive.current) setPhase({ kind: 'error', message })
      else console.warn('[dsh-message-rewind]', message)
    })
  }, [controller, mode, sessionId, t])

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

  return <span className="dmr-anchor">
    {face.Tooltip && !open ? <face.Tooltip label={label} side="bottom">{button}</face.Tooltip> : button}
    {open && <div className="dmr-panel" data-side={side} role="dialog" aria-label={label} ref={panel}>
      {phase.kind === 'loading' && <p>{t('loading')}</p>}
      {phase.kind === 'working' && <p role="status">{t(STEP_KEYS[phase.step])}</p>}
      {phase.kind === 'error' && <>
        {phase.message.split('\n').map((line, index) => <p key={index} data-tone="error">{line}</p>)}
        <div className="dmr-buttons"><button type="button" className="dmr-button" onClick={() => setPhase({ kind: 'idle' })}>{t('close')}</button></div>
      </>}
      {phase.kind === 'confirm' && <>
        <h4>{t(mode === 'retry' ? 'retryTitle' : 'rewindTitle')}</h4>
        {describe(phase.info, phase.running, mode, t).map((line, index) => <p key={index} data-tone={line.tone}>{line.text}</p>)}
        <div className="dmr-buttons">
          <button type="button" className="dmr-button" onClick={() => setPhase({ kind: 'idle' })}>{t('cancel')}</button>
          <button type="button" className="dmr-button" data-primary="" onClick={() => confirm(phase.info)}>
            {t(mode === 'retry' ? 'confirmRetry' : 'confirmRewind')}
          </button>
        </div>
      </>}
    </div>}
  </span>
}

/** The rewind row placed under one user message. */
export function UserRewindActions({ sessionId, seq, face }: { sessionId: string; seq: number; face: RewindFace }) {
  const [open, setOpen] = useState(false)
  return <div className="dmr-user-actions" data-open={open || undefined}>
    <RewindButton sessionId={sessionId} seq={seq} mode="edit" face={face} onOpenChange={setOpen} />
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
 * @returns the message seq to rewind to, or null.
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
