import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Chat renderers: the user-message shadow and the retry action. */
import { useEffect, useSyncExternalStore } from 'react';
import { ArmedNotice, RewindButton, UserRewindActions, retryTarget } from './components.js';
export const NODE_SLOT = 'conversation.chat.node';
/**
 * Pick the renderer this plugin shadows: the lowest-priority other entry for `key`.
 * @param slots - slot registry.
 * @param key - Chat Node kind.
 * @param self - this plugin's component.
 */
export function officialRenderer(slots, key, self) {
    let chosen;
    for (const entry of slots.entries(NODE_SLOT)) {
        if (entry.options.key !== key || entry.component === self)
            continue;
        if (chosen === undefined || (entry.options.priority ?? 0) < (chosen.options.priority ?? 0))
            chosen = entry;
    }
    return chosen?.component;
}
const noFeed = { subscribe: () => () => { }, getRevision: () => 0 };
/** Hold this Session's feed while the row is mounted and re-render when its ranges change. */
function useFeed(feeds, sessionId) {
    const feed = sessionId === undefined ? undefined : feeds?.ensure(sessionId);
    useEffect(() => {
        if (sessionId === undefined || feeds === undefined)
            return;
        feeds.acquire(sessionId);
        return () => feeds.release(sessionId);
    }, [feeds, sessionId]);
    useSyncExternalStore(feed?.subscribe ?? noFeed.subscribe, feed?.getRevision ?? noFeed.getRevision);
    return feed;
}
export function createUserNodeRenderer(slots, face, feeds) {
    function RewindableUserNode(props) {
        const kind = props.node?.kind ?? 'user';
        const Official = useSyncExternalStore(listener => slots.subscribe(NODE_SLOT, listener), () => officialRenderer(slots, kind, RewindableUserNode));
        const subagent = props.useSession?.((state) => state.subagent != null) ?? false;
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
        const feed = useFeed(subagent ? undefined : feeds, sessionId);
        const seq = props.node?.data?.seq;
        if (typeof seq === 'number' && sessionId !== undefined && feed) {
            if (feed.armedSeq() === seq)
                return _jsx("div", { className: "dmr-user-row", "data-message-rewind-seq": seq, children: _jsx(ArmedNotice, { sessionId: sessionId, face: face }) });
            if (feed.isHidden(seq))
                return null;
        }
        return _jsxs("div", { className: "dmr-user-row", "data-message-rewind-seq": seq, children: [Official ? _jsx(Official, { ...props }) : null, !subagent && typeof seq === 'number' && sessionId !== undefined
                    ? _jsx(UserRewindActions, { sessionId: sessionId, seq: seq, face: face })
                    : null] });
    }
    return RewindableUserNode;
}
export function createRetryAction(face) {
    return function RetryAction(props) {
        const seq = props.useChat?.((snapshot) => retryTarget(snapshot, props.messageId)) ?? null;
        const running = props.useSession?.((state) => state.running === true) ?? false;
        const subagent = props.useSession?.((state) => state.subagent != null) ?? false;
        if (seq === null || running || subagent || typeof props.sessionId !== 'string')
            return null;
        return _jsx(RewindButton, { sessionId: props.sessionId, seq: seq, mode: "retry", face: face, side: "top" });
    };
}
