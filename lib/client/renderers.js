import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Chat renderers: the user-message shadow and the retry action. */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ArmedNotice, RewindButton, UserRewindActions, retryTarget } from './components.js';
export const NODE_SLOT = 'conversation.chat.node';
/** Official chain the `user` bubble renders above its content (liveshare's origin line, for one). */
export const USER_BEFORE_SLOT = 'conversation.chat.user.before';
/**
 * This plugin's copy of {@link USER_BEFORE_SLOT}. The renderer hands
 * `renderSlotChain` only to an entry that declares a chain child, and only
 * for its own children; the official renderer declared the original, so the
 * shadow declares this copy and keeps it in sync.
 */
export const USER_BEFORE_MIRROR = 'dsh-message-rewind.user.before';
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
/**
 * The `renderSlotChain` the official renderer gets through the shadow: the
 * shadow's own binding with {@link USER_BEFORE_SLOT} routed to the mirror, or
 * the fallback when the entry received none.
 * @param own - `renderSlotChain` the renderer gave the shadow entry, if any.
 */
export function officialChain(own) {
    if (typeof own !== 'function')
        return (_key, _owner, options) => options?.fallback ?? null;
    const render = own;
    return (key, owner, options) => render(key === USER_BEFORE_SLOT ? USER_BEFORE_MIRROR : key, owner, options);
}
/**
 * Copy every entry of {@link USER_BEFORE_SLOT} into {@link USER_BEFORE_MIRROR},
 * in ledger order, until the returned disposer runs. Start it while the
 * mirror is declared.
 * @param slots - slot registry.
 * @param onError - a copy that failed to register; the chain renders without it.
 */
export function mirrorUserBefore(slots, onError) {
    let copied = [];
    let disposers = [];
    let disposed = false;
    const clear = () => { for (const dispose of disposers.splice(0).reverse()) {
        try {
            dispose();
        }
        catch { /* already gone */ }
    } };
    const sync = () => {
        if (disposed)
            return;
        const source = slots.entries(USER_BEFORE_SLOT);
        if (source.length === copied.length && source.every((entry, index) => entry === copied[index]))
            return;
        // Election takes the first match in ledger order; re-registering all keeps that order.
        clear();
        copied = source;
        for (const entry of source) {
            if (typeof entry.select !== 'function')
                continue;
            const options = { name: USER_BEFORE_MIRROR, select: entry.select };
            if (entry.options.priority !== undefined)
                options.priority = entry.options.priority;
            if (entry.inject !== undefined)
                options.inject = entry.inject;
            if (entry.locale !== undefined)
                options.locale = entry.locale;
            if (entry.store !== undefined)
                options.store = entry.store;
            if (entry.registrant !== undefined)
                options.registrant = entry.registrant;
            try {
                disposers.push(slots.register(options, entry.component));
            }
            catch (error) {
                onError?.(error);
            }
        }
    };
    const unsubscribe = slots.subscribe(USER_BEFORE_SLOT, sync);
    sync();
    return () => { disposed = true; unsubscribe(); clear(); disposers = []; copied = []; };
}
/**
 * Register the `user`/`steering` shadows and the chain mirror. Each call to
 * `slots.inject` follows its slot's declaration lifetime.
 * @param slots - slot registry of the plugin's fiber.
 * @param component - the shadow from {@link createUserNodeRenderer}.
 * @param priority - below the official entries' priority.
 */
export function registerUserNodes(slots, component, priority) {
    slots.inject(NODE_SLOT, () => slots.register({
        name: NODE_SLOT, key: 'user', locale: 'chat', priority,
        children: { [USER_BEFORE_MIRROR]: { kind: 'chain', scope: 'session' } },
    }, component));
    // The official steering entry renders no chain either.
    slots.inject(NODE_SLOT, () => slots.register({
        name: NODE_SLOT, key: 'steering', locale: 'chat', priority,
        inject: () => ({ renderSlotChain: () => null }),
    }, component));
    slots.inject(USER_BEFORE_MIRROR, () => mirrorUserBefore(slots, error => console.warn('[dsh-message-rewind] user.before mirror:', error)));
}
export function createUserNodeRenderer(slots, face, feeds) {
    function RewindableUserNode(props) {
        const kind = props.node?.kind ?? 'user';
        const Official = useSyncExternalStore(listener => slots.subscribe(NODE_SLOT, listener), () => officialRenderer(slots, kind, RewindableUserNode));
        // The official bubble calls renderSlotChain unconditionally; a throw here retires this shadow for the page.
        const renderSlotChain = useMemo(() => officialChain(props.renderSlotChain), [props.renderSlotChain]);
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
        return _jsxs("div", { className: "dmr-user-row", "data-message-rewind-seq": seq, children: [Official ? _jsx(Official, { ...props, renderSlotChain: renderSlotChain }) : null, !subagent && typeof seq === 'number' && sessionId !== undefined
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
