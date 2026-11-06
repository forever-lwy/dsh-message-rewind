import { type ReactNode } from 'react';
import type { RewindInspection } from '../remote.js';
import type { RewindController, RewindMode } from './controller.js';
export type Translate = (key: string) => string;
/** What a rewind button needs from the plugin. */
export interface RewindFace {
    controller: RewindController;
    t: Translate;
    Tooltip?: ((props: {
        label: string;
        side?: string;
        children: ReactNode;
    }) => ReactNode) | undefined;
    RetryIcon?: (() => ReactNode) | undefined;
}
export declare function UndoIcon(): import("react").JSX.Element;
export declare function RefreshIcon(): import("react").JSX.Element;
export declare const isModified: (info: RewindInspection) => boolean;
/** The warning or confirmation lines for one inspection. */
export declare function describe(info: RewindInspection, mode: RewindMode, t: Translate): {
    text: string;
    tone?: 'warn';
}[];
/**
 * One rewind or retry button with its inline confirmation panel.
 * @param props - target message, mode, and the plugin face.
 */
export declare function RewindButton({ sessionId, seq, mode, face, side, onOpenChange }: {
    sessionId: string;
    seq: number;
    mode: RewindMode;
    face: RewindFace;
    side?: 'top' | 'bottom';
    onOpenChange?: (open: boolean) => void;
}): import("react").JSX.Element;
/** The rewind and regenerate row under one user message. */
export declare function UserRewindActions({ sessionId, seq, face }: {
    sessionId: string;
    seq: number;
    face: RewindFace;
}): import("react").JSX.Element;
/** Shown in place of a message whose edit is pending in the composer. */
export declare function ArmedNotice({ sessionId, face }: {
    sessionId: string;
    face: RewindFace;
}): import("react").JSX.Element;
/** Minimal Chat snapshot surface the retry button reads. */
export interface ChatSnapshotLike {
    timeline?: {
        turnOrder?: readonly number[];
        turns?: {
            get(turn: number): any;
        };
    };
    locations?: {
        getTurn(turn: number): readonly string[];
    };
    nodes?: {
        get(key: string): any;
    };
}
/**
 * The latest human message of the last Turn, when `messageId` closes that Turn.
 * @param snapshot - Chat snapshot.
 * @param messageId - assistant message the action strip belongs to.
 * @returns the message seq to regenerate from, or null.
 */
export declare function retryTarget(snapshot: ChatSnapshotLike, messageId: string): number | null;
