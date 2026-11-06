export function isHumanMessage(event) {
    return event?.type === 'user/message' && event.data?.source?.kind === 'user';
}
function replaceOf(event) {
    const op = event.surfaceOp;
    if (typeof op !== 'object' || op === null || op.op !== 'replace')
        return undefined;
    return typeof op.startSeq === 'number' && typeof op.endSeq === 'number' ? { startSeq: op.startSeq, endSeq: op.endSeq } : undefined;
}
/** Markers of this plugin and dsh-redo (empty system message) and of dsh-rewind-plugin. */
function isRewindMarker(event) {
    if (event.type === 'system/message') {
        const content = event.data?.message?.content;
        return Array.isArray(content) && content.length === 0;
    }
    return event.type === 'user/message' && event.data?.source?.kind === 'dsh-rewind';
}
/**
 * Where a withdrawal starts: before the Turn when the message opened it, so
 * the Turn disappears whole, or at the message itself when it was steered in.
 * @param events - the loaded window in seq order.
 * @param index - position of the human message.
 */
export function withdrawalStart(events, index) {
    const target = events[index];
    for (let at = index - 1; at >= 0; at--) {
        const event = events[at];
        if (event.type === 'turn/end')
            break;
        if (event.type === 'assistant/message' || isHumanMessage(event))
            return target.seq;
        if (event.type === 'turn/start')
            return event.seq;
    }
    return target.seq;
}
/**
 * The range one marker withdrew, or null when `events[index]` is no rewind.
 * @param events - the loaded window in seq order.
 * @param index - position of a candidate marker.
 */
export function rewindRange(events, index) {
    const marker = events[index];
    const op = replaceOf(marker);
    if (op === undefined || !isRewindMarker(marker))
        return null;
    let targetIndex = -1;
    for (let at = index - 1; at >= 0; at--) {
        const seq = events[at].seq;
        if (seq === op.startSeq) {
            targetIndex = at;
            break;
        }
        if (seq < op.startSeq)
            break;
    }
    // System-prompt normalization also empties single system nodes; a rewind always starts at a human message.
    if (targetIndex >= 0 ? !isHumanMessage(events[targetIndex]) : op.startSeq === op.endSeq)
        return null;
    const from = targetIndex >= 0 ? withdrawalStart(events, targetIndex) : op.startSeq;
    let to = marker.type === 'user/message' ? marker.seq + 1 : marker.seq;
    // The marker opens the replacing Turn; that Turn stays visible.
    const turn = marker.data?.turn;
    if (marker.type === 'system/message' && typeof turn === 'number') {
        for (let at = index - 1; at >= 0 && events[at].seq > from; at--) {
            const event = events[at];
            if (event.type === 'turn/start' && event.data?.turn === turn) {
                to = event.seq;
                break;
            }
        }
    }
    return { from, to, target: op.startSeq };
}
const inRange = (ranges, seq) => typeof seq === 'number' && ranges.some(range => seq >= range.from && seq < range.to);
const quote = (value) => `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
/**
 * CSS hiding `ranges` inside one Session's conversation.
 * @param sessionId - Session whose conversation root carries `data-conversation-session`.
 * @param ranges - withdrawn ranges.
 * @param turnStarts - Turn number → its `turn/start` seq.
 * @param chat - current Chat snapshot.
 */
export function hidingCss(sessionId, ranges, turnStarts, chat) {
    if (ranges.length === 0)
        return '';
    const scope = `[data-conversation-session=${quote(sessionId)}]`;
    const keeps = ranges.flatMap(range => range.keep === undefined ? [] : [range.keep]);
    const selectors = [];
    const keysInHiddenTurns = new Set();
    const starts = [...turnStarts].sort((a, b) => a[1] - b[1]);
    for (const [index, [turn, start]] of starts.entries()) {
        if (!inRange(ranges, start))
            continue;
        // A Turn holding a kept message is hidden node by node instead.
        const end = starts[index + 1]?.[1] ?? Infinity;
        if (keeps.some(keep => keep >= start && keep < end))
            continue;
        for (const key of chat?.locations?.getTurn(turn) ?? [])
            keysInHiddenTurns.add(key);
        selectors.push(`${scope} [data-chat-turn=${quote(String(turn))}]`);
    }
    for (const node of chat?.nodes?.values() ?? []) {
        if (keysInHiddenTurns.has(node.key))
            continue;
        const seq = node.anchorSeq ?? node.data?.seq;
        if (!inRange(ranges, seq) || keeps.includes(node.data?.seq))
            continue;
        selectors.push(`${scope} [data-chat-node-key=${quote(node.key)}]`);
    }
    return selectors.length === 0 ? '' : `${selectors.join(',\n')} { display: none !important; }\n`;
}
/** Withdrawn ranges and the pending edit of one Session. */
export class SessionFeed {
    sessionId;
    deps;
    ranges = [];
    turnStarts = new Map();
    armed = null;
    revision = 0;
    eventRevision = -1;
    listeners = new Set();
    stops = [];
    chatStop;
    lastOrder;
    lastCss = '';
    constructor(sessionId, deps) {
        this.sessionId = sessionId;
        this.deps = deps;
        if (deps.events) {
            this.stops.push(deps.events.subscribe(() => this.read()));
            this.read();
        }
        void deps.state?.().then(({ armed }) => { if (armed && !this.armed)
            this.setArmed(armed); }, () => { });
    }
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    getRevision = () => this.revision;
    /** Whether the message at `seq` was withdrawn (or is pending withdrawal). */
    isHidden(seq) {
        return inRange(this.visibleRanges(), seq) && this.armed?.seq !== seq;
    }
    armedSeq() {
        return this.armed?.seq ?? null;
    }
    /** Mark a pending edit: `armed.seq` through `armed.lastSeq` leave the transcript until it is sent or undone. */
    setArmed(armed) {
        if (armed === null)
            this.armed = null;
        else {
            const events = this.events();
            const index = events.findIndex(event => event.seq === armed.seq);
            this.armed = { ...armed, from: index >= 0 ? withdrawalStart(events, index) : armed.seq };
        }
        this.changed();
    }
    hiddenRanges() {
        return this.visibleRanges();
    }
    dispose() {
        for (const stop of this.stops.splice(0))
            stop();
        this.chatStop?.();
        this.chatStop = undefined;
        this.listeners.clear();
        this.deps.writeCss('');
    }
    visibleRanges() {
        return this.armed === null ? this.ranges
            : [...this.ranges, { from: this.armed.from, to: this.armed.lastSeq + 1, target: this.armed.seq, keep: this.armed.seq }];
    }
    events() {
        const entries = this.deps.events?.getSnapshot().entries ?? [];
        const events = [];
        for (const entry of entries)
            if (entry.type === 'event')
                events.push(entry.event);
        return events;
    }
    /** Scan only the entries the latest change added. */
    read() {
        const window = this.deps.events.getSnapshot();
        if (window.revision === this.eventRevision)
            return;
        this.eventRevision = window.revision;
        const kind = window.change?.kind;
        if (kind === 'settle-assistant')
            return;
        const entries = window.entries;
        const added = window.change?.entries?.length ?? entries.length;
        let start = 0;
        let end = entries.length;
        // Older history paging in may hold nodes of a known range.
        let found = kind !== 'append' && this.visibleRanges().length > 0;
        if (kind === 'append')
            start = Math.max(0, entries.length - added);
        else if (kind === 'prepend')
            end = Math.min(entries.length, added);
        else {
            this.ranges = [];
            this.turnStarts.clear();
        }
        let events;
        for (let index = start; index < end; index++) {
            const entry = entries[index];
            if (entry.type !== 'event')
                continue;
            const event = entry.event;
            if (event.type === 'turn/start' && typeof event.data?.turn === 'number')
                this.turnStarts.set(event.data.turn, event.seq);
            if (replaceOf(event) === undefined)
                continue;
            events ??= this.events();
            const at = events.findIndex(candidate => candidate.seq === event.seq);
            const range = at >= 0 ? rewindRange(events, at) : null;
            if (range === null)
                continue;
            this.ranges.push(range);
            if (this.armed?.seq === range.target)
                this.armed = null;
            found = true;
        }
        if (found)
            this.changed();
    }
    changed() {
        this.revision++;
        const ranges = this.visibleRanges();
        if (ranges.length > 0 && this.chatStop === undefined && this.deps.chat) {
            this.chatStop = this.deps.chat.subscribe(() => {
                const order = this.deps.chat.getSnapshot()?.order;
                if (order !== this.lastOrder)
                    this.restyle();
            });
        }
        else if (ranges.length === 0 && this.chatStop !== undefined) {
            this.chatStop();
            this.chatStop = undefined;
        }
        this.restyle();
        for (const listener of [...this.listeners])
            listener();
    }
    restyle() {
        const chat = this.deps.chat?.getSnapshot();
        this.lastOrder = chat?.order;
        const css = hidingCss(this.sessionId, this.visibleRanges(), this.turnStarts, chat);
        if (css === this.lastCss)
            return;
        this.lastCss = css;
        this.deps.writeCss(css);
    }
}
/** Reference-counted feeds, one per Session shown in a conversation. */
export class FeedRegistry {
    create;
    graceMs;
    feeds = new Map();
    constructor(create, graceMs = 600_000) {
        this.create = create;
        this.graceMs = graceMs;
    }
    peek(sessionId) {
        return this.feeds.get(sessionId)?.feed;
    }
    /** The feed for `sessionId`, created on first use; unheld, it lapses after the grace period. */
    ensure(sessionId) {
        const existing = this.feeds.get(sessionId);
        if (existing !== undefined)
            return existing.feed;
        const slot = { feed: this.create(sessionId), users: 0 };
        this.feeds.set(sessionId, slot);
        this.schedule(sessionId, slot);
        return slot.feed;
    }
    acquire(sessionId) {
        this.ensure(sessionId);
        const slot = this.feeds.get(sessionId);
        if (slot.timer !== undefined) {
            clearTimeout(slot.timer);
            slot.timer = undefined;
        }
        slot.users++;
        return slot.feed;
    }
    /** Rows mount and unmount as the transcript pages; a feed outlives a short gap. */
    release(sessionId) {
        const slot = this.feeds.get(sessionId);
        if (slot === undefined || --slot.users > 0)
            return;
        this.schedule(sessionId, slot);
    }
    schedule(sessionId, slot) {
        slot.timer = setTimeout(() => {
            if (slot.users > 0)
                return;
            this.feeds.delete(sessionId);
            slot.feed.dispose();
        }, this.graceMs);
        slot.timer.unref?.();
    }
    dispose() {
        for (const slot of this.feeds.values()) {
            clearTimeout(slot.timer);
            slot.feed.dispose();
        }
        this.feeds.clear();
    }
}
