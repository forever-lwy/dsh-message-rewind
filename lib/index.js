var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
/**
 * Rewind a conversation to one of its user messages, in place.
 *
 * Host half. The Session log is append-only, so a rewind appends one empty
 * system message whose surface replacement shadows the target message and
 * everything after it — the same in-place mechanism `/compact` uses. The
 * marker is appended at the `agent/request` of the step that admits the
 * replacing message, right before that message joins the surface, so the
 * model never sees the withdrawn exchange and nothing is withdrawn until a
 * new message is actually sent.
 *
 * - Edit: `arm` marks the target; the next message the person sends (from the
 *   composer, with the original text and attachments refilled by the client)
 *   replaces it.
 * - Retry: `retry` sends the original message again, reusing its durable
 *   attachment references, and replaces the target with it.
 *
 * Workspace files are not restored. `inspect` reports the file edits recorded
 * after the target so the client can warn before a rewind.
 */
import { randomUUID } from 'node:crypto';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import { armSchema, attachmentRequestSchema, remoteInfo, retrySchema, sessionSchema, targetSchema, } from './remote.js';
export const name = 'dsh-message-rewind';
export const inject = ['typert', 'attachments', 'agents'];
export const Config = z.object({
    mutatingTools: z.array(z.string()).default(['write', 'edit']).description('视为修改工作区文件的工具名；回退或重新生成涉及这些工具时弹出警告'),
    attachmentMaxBytes: z.natural().min(1).default(64 * 1024 * 1024).description('回填输入框时单个附件的最大字节数'),
    stopTimeoutMs: z.natural().min(1000).default(20_000).description('回退前等待运行中的任务停止的最长时间（毫秒）'),
});
/** Whether one event is a message the human sent (not runtime context or other injected input). */
export function isHumanMessage(event) {
    return event?.type === 'user/message' && event.data?.source?.kind === 'user';
}
function isHumanPrompt(message) {
    return message.source?.kind === 'user' && typeof message.source.rpcId === 'string';
}
function contentOf(event) {
    const content = event?.data?.content;
    return Array.isArray(content) ? content : [];
}
function attachmentsOf(content) {
    return content.filter((block) => (block.type === 'image' || block.type === 'file') && typeof block.attachment === 'object' && block.attachment !== null);
}
function textOf(content) {
    return content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
}
/**
 * Why `seq` cannot be rewound in place, or null when it can.
 * @param session - the live Session.
 * @param seq - candidate human message.
 */
export function refusalOf(session, seq) {
    const index = session.surface.nodes.indexOf(seq);
    if (index < 0)
        return 'missing';
    if (index === 0)
        return 'head';
    return isHumanMessage(session.eventAt(seq)) ? null : 'not-user';
}
/**
 * Workspace edits and human messages recorded after `seq`.
 * @param events - the log from `seq` on.
 * @param seq - target message.
 * @param tools - names of file-editing tools.
 * @param surface - current surface nodes, to count only messages still in context.
 */
export function laterActivity(events, seq, tools, surface) {
    const turns = new Set();
    const visible = new Set(surface);
    let edits = 0;
    let laterMessages = 0;
    for (const event of events) {
        if (event.seq <= seq)
            continue;
        if (event.type === 'workspace/changes')
            turns.add(event.data?.turn ?? event.seq);
        else if (event.type === 'tool/call' && tools.includes(event.data?.name))
            edits++;
        else if (isHumanMessage(event) && visible.has(event.seq))
            laterMessages++;
    }
    return { modified: { turns: turns.size, edits }, laterMessages };
}
/**
 * Shadow `target` and every later surface node with one empty system message.
 * @param session - the live Session, between `agent/request` and the step's input.
 * @param target - human message to withdraw.
 * @param turn - current turn.
 * @param step - current step.
 * @returns the marker event.
 */
export function rewindSurface(session, target, turn, step) {
    const refusal = refusalOf(session, target);
    if (refusal !== null)
        throw new Error(`message ${target} cannot be rewound (${refusal})`);
    const nodes = [...session.surface.nodes];
    const shadowed = nodes.slice(nodes.indexOf(target));
    return session.append('system/message', {
        turn,
        step,
        // Empty later system nodes are dormant: they project to no provider message.
        message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [] },
    }, {
        surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
        sourceEventSeqs: shadowed,
    });
}
const errorText = (error) => error instanceof Error ? error.message : String(error);
function refusalText(refusal) {
    return {
        missing: '这条消息已不在模型上下文中（可能已被压缩），无法回退。',
        head: '会话开头的消息无法回退。',
        'not-user': '只能回退你发送的消息。',
    }[refusal];
}
let MessageRewindService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _inspect_decorators;
    let _attachment_decorators;
    let _arm_decorators;
    let _disarm_decorators;
    let _state_decorators;
    let _retry_decorators;
    return class MessageRewindService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _inspect_decorators = [Remote];
            _attachment_decorators = [Remote];
            _arm_decorators = [Remote];
            _disarm_decorators = [Remote];
            _state_decorators = [Remote];
            _retry_decorators = [Remote];
            __esDecorate(this, null, _inspect_decorators, { kind: "method", name: "inspect", static: false, private: false, access: { has: obj => "inspect" in obj, get: obj => obj.inspect }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _attachment_decorators, { kind: "method", name: "attachment", static: false, private: false, access: { has: obj => "attachment" in obj, get: obj => obj.attachment }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _arm_decorators, { kind: "method", name: "arm", static: false, private: false, access: { has: obj => "arm" in obj, get: obj => obj.arm }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _disarm_decorators, { kind: "method", name: "disarm", static: false, private: false, access: { has: obj => "disarm" in obj, get: obj => obj.disarm }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _state_decorators, { kind: "method", name: "state", static: false, private: false, access: { has: obj => "state" in obj, get: obj => obj.state }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _retry_decorators, { kind: "method", name: "retry", static: false, private: false, access: { has: obj => "retry" in obj, get: obj => obj.retry }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        settings = __runInitializers(this, _instanceExtraInitializers);
        /** Edits waiting for the next human message, per live Agent. */
        armed = new WeakMap();
        /** Retried messages by id → the target they replace. */
        retries = new Map();
        /** Rewinds to apply at this Agent's next matching `agent/request`. */
        plans = new WeakMap();
        inflight = new Set();
        constructor(ctx, settings) {
            super(ctx, 'messageRewind');
            this.settings = settings;
        }
        lookup(sessionId) {
            return this.ctx.agents?.get?.(sessionId);
        }
        agent(sessionId) {
            const agent = this.lookup(sessionId);
            if (agent === undefined)
                throw new RemoteError('gateway/bad-request', '会话未加载，请重新打开后再试。', {});
            return agent;
        }
        describe(agent, seq) {
            const session = agent.session;
            const content = contentOf(session.eventAt(seq));
            const limit = this.settings().attachmentMaxBytes;
            const attachments = attachmentsOf(content).map(block => ({
                kind: block.type,
                name: String(block.attachment.name ?? (block.type === 'image' ? 'image' : 'file')),
                bytes: Number(block.attachment.bytes ?? 0),
                ...(block.type === 'image' ? { mediaType: String(block.attachment.mediaType) } : {}),
                available: Number(block.attachment.bytes ?? 0) <= limit,
            }));
            const activity = laterActivity(session.snapshotEvents(seq), seq, this.settings().mutatingTools, session.surface.nodes);
            return {
                sessionId: session.id, seq, refusal: refusalOf(session, seq),
                text: textOf(content), attachments, ...activity,
                running: agent.status !== 'idle',
            };
        }
        /** Stop a running Agent, discarding its queued input: all of it comes after the target. */
        async stop(agent) {
            if (agent.status === 'idle')
                return;
            agent.cancel({ kind: 'user' });
            let timer;
            try {
                await Promise.race([
                    agent.whenIdle(),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop-timeout')), this.settings().stopTimeoutMs); }),
                ]);
            }
            catch {
                throw new RemoteError('gateway/bad-request', '当前任务未能及时停止，请稍后再试。', {});
            }
            finally {
                clearTimeout(timer);
            }
        }
        /**
         * Stop the Agent, re-check the target, and run `act` unless stopping
         * surfaced workspace edits the person has not been warned about.
         */
        async prepare(sessionId, seq, knownModified, act) {
            if (this.inflight.has(sessionId))
                throw new RemoteError('gateway/bad-request', '正在处理上一次回退，请稍候。', {});
            this.inflight.add(sessionId);
            try {
                const agent = this.agent(sessionId);
                await this.stop(agent);
                const inspection = this.describe(agent, seq);
                if (inspection.refusal !== null)
                    throw new RemoteError('gateway/bad-request', refusalText(inspection.refusal), {});
                const modified = inspection.modified.turns + inspection.modified.edits > 0;
                if (modified && !knownModified)
                    return { status: 'confirm', inspection };
                return act(agent);
            }
            finally {
                this.inflight.delete(sessionId);
            }
        }
        async inspect(request, signal) {
            signal.throwIfAborted();
            const parsed = targetSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '回退参数无效。', {});
            return this.describe(this.agent(parsed.data.sessionId), parsed.data.seq);
        }
        async attachment(request, signal) {
            const parsed = attachmentRequestSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '附件参数无效。', {});
            const { sessionId, seq, index } = parsed.data;
            const event = this.agent(sessionId).session.eventAt(seq);
            if (!isHumanMessage(event))
                throw new RemoteError('gateway/bad-request', '找不到这条用户消息。', {});
            const block = attachmentsOf(contentOf(event))[index];
            if (block === undefined)
                throw new RemoteError('gateway/bad-request', '附件不存在。', {});
            const limit = this.settings().attachmentMaxBytes;
            if (Number(block.attachment.bytes ?? 0) > limit)
                throw new RemoteError('gateway/bad-request', '附件超过回填大小上限。', {});
            if (block.type === 'image') {
                const stored = await this.ctx.attachments.readImage(block.attachment, signal);
                return { name: block.attachment.name ?? `image-${index + 1}`, mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') };
            }
            const chunks = [];
            let total = 0;
            for await (const chunk of this.ctx.attachments.readFileStream(block.attachment, signal)) {
                total += chunk.byteLength;
                if (total > limit)
                    throw new RemoteError('gateway/bad-request', '附件超过回填大小上限。', {});
                chunks.push(Buffer.from(chunk));
            }
            return { name: block.attachment.name, mediaType: 'application/octet-stream', data: Buffer.concat(chunks).toString('base64') };
        }
        async arm(request, signal) {
            signal.throwIfAborted();
            const parsed = armSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '回退参数无效。', {});
            const { sessionId, seq, knownModified } = parsed.data;
            return this.prepare(sessionId, seq, knownModified, agent => {
                const armed = { seq, lastSeq: agent.session.seq - 1 };
                this.armed.set(agent, armed);
                return { status: 'armed', armed };
            });
        }
        async disarm(request) {
            const parsed = sessionSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '参数无效。', {});
            const agent = this.lookup(parsed.data.sessionId);
            if (agent)
                this.armed.delete(agent);
            return { ok: true };
        }
        async state(request) {
            const parsed = sessionSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '参数无效。', {});
            const agent = this.lookup(parsed.data.sessionId);
            return { armed: (agent && this.armed.get(agent)) ?? null };
        }
        async retry(request, signal) {
            signal.throwIfAborted();
            const parsed = retrySchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '重新生成参数无效。', {});
            const { sessionId, seq, knownModified, note } = parsed.data;
            return this.prepare(sessionId, seq, knownModified, agent => {
                const event = agent.session.eventAt(seq);
                const content = [...contentOf(event)];
                if (note)
                    content.push({ type: 'text', text: `\n\n${note}` });
                const source = { ...(event?.data?.source ?? { kind: 'user' }), rpcId: `message-rewind:${randomUUID()}` };
                // The original durable attachment references are reused as they are.
                const message = Object.freeze({ id: randomUUID(), role: 'user', content: structuredClone(content), source });
                this.armed.delete(agent);
                this.retries.set(message.id, seq);
                agent.followup(message);
                return { status: 'sent' };
            });
        }
        /** `agent/pre-step`: a step admitting a retried or edited message plans its rewind. */
        claim(agent, messages, turn, step) {
            for (const message of messages) {
                const target = typeof message.id === 'string' ? this.retries.get(message.id) : undefined;
                if (target === undefined)
                    continue;
                this.retries.delete(message.id);
                this.plans.set(agent, { turn, step, target });
                return;
            }
            const armed = this.armed.get(agent);
            if (armed !== undefined && messages.some(isHumanPrompt)) {
                this.armed.delete(agent);
                this.plans.set(agent, { turn, step, target: armed.seq });
            }
        }
        /** `agent/request`: shadow the withdrawn range before the step's new message is admitted. */
        apply(agent, turn, step) {
            const plan = this.plans.get(agent);
            if (plan === undefined || plan.turn !== turn || plan.step !== step)
                return;
            this.plans.delete(agent);
            try {
                rewindSurface(agent.session, plan.target, turn, step);
            }
            catch (error) {
                // The message still goes out; only the withdrawal is skipped.
                this.ctx.logger.warn('message-rewind: rewinding %s to %d failed: %s', agent.id, plan.target, errorText(error));
            }
        }
    };
})();
export { MessageRewindService };
export function apply(ctx, config = {}) {
    const settings = () => Config(config);
    ctx.typert.remotes.register(remoteInfo);
    const service = new MessageRewindService(ctx, settings);
    const on = ctx.on.bind(ctx);
    on('agent/pre-step', async (payload, next) => {
        service.claim(payload.agent, payload.messages, payload.turn, payload.step);
        return next();
    });
    on('agent/request', async (payload, next) => {
        service.apply(payload.agent, payload.turn, payload.step);
        return next();
    });
}
