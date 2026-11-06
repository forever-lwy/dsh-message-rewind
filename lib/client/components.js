import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from './locales.js';
export function UndoIcon() {
    return _jsxs("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [_jsx("path", { d: "M5.5 3.5 2.5 6.5l3 3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }), _jsx("path", { d: "M3 6.5h6.25a4 4 0 0 1 0 8H6.5", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })] });
}
export function RefreshIcon() {
    return _jsxs("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [_jsx("path", { d: "M13 8a5 5 0 1 1-1.46-3.54", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }), _jsx("path", { d: "M13 3v2.5h-2.5", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" })] });
}
export const isModified = (info) => info.modified.turns + info.modified.edits > 0;
/** The warning or confirmation lines for one inspection. */
export function describe(info, mode, t) {
    const lines = [];
    if (isModified(info)) {
        const parts = [
            info.modified.turns > 0 ? format(t('modifiedTurns'), { count: info.modified.turns }) : '',
            info.modified.edits > 0 ? format(t('modifiedEdits'), { count: info.modified.edits }) : '',
        ].filter(Boolean).join(t('listSeparator'));
        lines.push({ text: format(t(mode === 'retry' ? 'modifiedRetry' : 'modifiedEdit'), { details: parts }), tone: 'warn' });
    }
    if (info.laterMessages > 0)
        lines.push({ text: format(t('laterMessages'), { count: info.laterMessages }) });
    else
        lines.push({ text: t(mode === 'retry' ? 'retryBody' : 'editBody') });
    if (mode === 'edit') {
        const tooLarge = info.attachments.filter(attachment => !attachment.available).length;
        if (tooLarge > 0)
            lines.push({ text: format(t('attachmentsTooLarge'), { count: tooLarge }), tone: 'warn' });
    }
    if (info.running)
        lines.push({ text: t('running'), tone: 'warn' });
    return lines;
}
function noticeText(notice, t) {
    return format(t(notice.key), notice.values);
}
function refusalText(refusal, t) {
    return t(`refusal.${refusal}`);
}
/**
 * One rewind or retry button with its inline confirmation panel.
 * @param props - target message, mode, and the plugin face.
 */
export function RewindButton({ sessionId, seq, mode, face, side = 'bottom', onOpenChange }) {
    const { controller, t } = face;
    const [phase, setPhase] = useState({ kind: 'idle' });
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    const open = phase.kind !== 'idle';
    useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
    const panel = useRef(null);
    useEffect(() => {
        if (phase.kind !== 'warn' && phase.kind !== 'confirm' && phase.kind !== 'error')
            return;
        const onKey = (event) => { if (event.key === 'Escape')
            setPhase({ kind: 'idle' }); };
        const onPointer = (event) => {
            if (panel.current && event.target instanceof Node && !panel.current.parentElement?.contains(event.target))
                setPhase({ kind: 'idle' });
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointer);
        return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
    }, [phase.kind]);
    const fail = useCallback((error) => {
        const message = format(t('failed'), { message: error instanceof Error ? error.message : String(error) });
        if (alive.current)
            setPhase({ kind: 'error', message });
        else
            console.warn('[dsh-message-rewind]', message);
    }, [t]);
    const act = useCallback((info, options) => {
        setPhase({ kind: 'working' });
        controller.run(sessionId, info, mode, options).then(outcome => {
            if (!alive.current)
                return;
            if (outcome.status === 'confirm')
                setPhase({ kind: 'warn', info: outcome.inspection });
            else if (outcome.notices.length > 0)
                setPhase({ kind: 'error', message: outcome.notices.map(notice => noticeText(notice, t)).join('\n') });
            else
                setPhase({ kind: 'idle' });
        }, fail);
    }, [controller, fail, mode, sessionId, t]);
    const start = useCallback(() => {
        if (phase.kind !== 'idle') {
            if (phase.kind !== 'working')
                setPhase({ kind: 'idle' });
            return;
        }
        setPhase({ kind: 'loading' });
        controller.inspect(sessionId, seq).then(info => {
            if (!alive.current)
                return;
            if (info.refusal !== null)
                setPhase({ kind: 'error', message: refusalText(info.refusal, t) });
            else if (isModified(info))
                setPhase({ kind: 'warn', info });
            else if (info.running || (mode === 'retry' && info.laterMessages > 0))
                setPhase({ kind: 'confirm', info });
            else
                act(info, { knownModified: false, note: null });
        }, fail);
    }, [act, controller, fail, mode, phase.kind, sessionId, seq, t]);
    const label = t(mode === 'retry' ? 'retry' : 'rewind');
    const button = _jsx("button", { type: "button", className: "dmr-action", "aria-label": label, "aria-expanded": open, "data-rewind-mode": mode, disabled: phase.kind === 'working', onClick: start, children: mode === 'retry' ? (face.RetryIcon ? _jsx(face.RetryIcon, {}) : _jsx(RefreshIcon, {})) : _jsx(UndoIcon, {}) });
    const note = t(mode === 'retry' ? 'noteRetry' : 'noteEdit');
    return _jsxs("span", { className: "dmr-anchor", children: [face.Tooltip && !open ? _jsx(face.Tooltip, { label: label, side: "bottom", children: button }) : button, open && _jsxs("div", { className: "dmr-panel", "data-side": side, role: "dialog", "aria-label": label, ref: panel, "data-phase": phase.kind, children: [phase.kind === 'loading' && _jsx("p", { children: t('loading') }), phase.kind === 'working' && _jsx("p", { role: "status", children: t(mode === 'retry' ? 'sending' : 'preparing') }), phase.kind === 'error' && _jsxs(_Fragment, { children: [phase.message.split('\n').map((line, index) => _jsx("p", { "data-tone": "error", children: line }, index)), _jsx("div", { className: "dmr-buttons", children: _jsx("button", { type: "button", className: "dmr-button", onClick: () => setPhase({ kind: 'idle' }), children: t('close') }) })] }), (phase.kind === 'warn' || phase.kind === 'confirm') && _jsxs(_Fragment, { children: [_jsx("h4", { children: t(phase.kind === 'warn' ? 'warnTitle' : (mode === 'retry' ? 'retryTitle' : 'rewindTitle')) }), describe(phase.info, mode, t).map((line, index) => _jsx("p", { "data-tone": line.tone, children: line.text }, index)), phase.kind === 'warn' && _jsx("p", { className: "dmr-note", children: format(t('noteHint'), { note }) }), _jsxs("div", { className: "dmr-buttons", children: [_jsx("button", { type: "button", className: "dmr-button", onClick: () => setPhase({ kind: 'idle' }), children: t('cancel') }), _jsx("button", { type: "button", className: "dmr-button", "data-primary": phase.kind === 'confirm' ? '' : undefined, onClick: () => act(phase.info, { knownModified: true, note: null }), children: t('confirm') }), phase.kind === 'warn' && _jsx("button", { type: "button", className: "dmr-button", "data-primary": "", onClick: () => act(phase.info, { knownModified: true, note }), children: t('confirmWithNote') })] })] })] })] });
}
/** The rewind and regenerate row under one user message. */
export function UserRewindActions({ sessionId, seq, face }) {
    const [editOpen, setEditOpen] = useState(false);
    const [retryOpen, setRetryOpen] = useState(false);
    return _jsxs("div", { className: "dmr-user-actions", "data-open": editOpen || retryOpen || undefined, children: [_jsx(RewindButton, { sessionId: sessionId, seq: seq, mode: "retry", face: face, onOpenChange: setRetryOpen }), _jsx(RewindButton, { sessionId: sessionId, seq: seq, mode: "edit", face: face, onOpenChange: setEditOpen })] });
}
/** Shown in place of a message whose edit is pending in the composer. */
export function ArmedNotice({ sessionId, face }) {
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const undo = () => {
        setBusy(true);
        face.controller.undo(sessionId).then(() => setBusy(false), error => {
            setBusy(false);
            setError(format(face.t('failed'), { message: error instanceof Error ? error.message : String(error) }));
        });
    };
    return _jsxs("div", { className: "dmr-armed", role: "status", children: [_jsx("span", { children: face.t('armed') }), _jsx("button", { type: "button", className: "dmr-button", disabled: busy, onClick: undo, children: face.t('undoRewind') }), error && _jsx("span", { "data-tone": "error", children: error })] });
}
/**
 * The latest human message of the last Turn, when `messageId` closes that Turn.
 * @param snapshot - Chat snapshot.
 * @param messageId - assistant message the action strip belongs to.
 * @returns the message seq to regenerate from, or null.
 */
export function retryTarget(snapshot, messageId) {
    const last = snapshot.timeline?.turnOrder?.at(-1);
    if (last === undefined)
        return null;
    const turn = snapshot.timeline?.turns?.get(last);
    if (turn?.data?.get?.('turn-tail')?.closing?.finalNode?.messageId !== messageId)
        return null;
    const keys = snapshot.locations?.getTurn(last) ?? [];
    for (let index = keys.length - 1; index >= 0; index--) {
        const node = snapshot.nodes?.get(keys[index]);
        if ((node?.kind === 'user' || node?.kind === 'steering') && typeof node.data?.seq === 'number')
            return node.data.seq;
    }
    return null;
}
