import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { LlmRuntime, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Plugin from '../lib/index.js'

const signal = new AbortController().signal
const image = Buffer.from('fake-png-bytes')
const file = Buffer.from('report body')

/** A real rc.5 Session behind a minimal Agent and the agent hooks the loop dispatches. */
async function setup(config = {}) {
  const ctx = new Context()
  const descriptors = []
  ctx.provide('typert', {
    lookups: { register: () => () => {} },
    contexts: { registerHost: () => () => {} },
    remotes: { register: info => { descriptors.push(info); return () => {} } },
  })
  ctx.provide('attachments', {
    readImage: async ref => ({ ref, data: new Uint8Array(image) }),
    readFileStream: async function* () { yield new Uint8Array(file.subarray(0, 4)); yield new Uint8Array(file.subarray(4)) },
  })
  const agents = new Map()
  ctx.provide('agents', { get: id => agents.get(id) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Plugin, config)
  const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd: '/work' } })
  const agent = {
    id: 's1', session, status: 'idle', sent: [], cancels: 0,
    cancel() { this.cancels++; this.status = 'idle' },
    whenIdle: async () => {},
    followup(message) { this.sent.push(message) },
  }
  agents.set('s1', agent)
  return { ctx, descriptors, session, agent, service: ctx.messageRewind }
}

const human = (content, rpcId = 'rpc') => createUserMessage({ content, source: { kind: 'user', rpcId } })
const reply = text => createAssistantMessage({ content: [{ type: 'text', text }], provider: 'p', model: 'm', stopReason: 'stop' })

/** One closed Turn: the human message, optional tool activity, and a reply. */
function turn(session, number, content, { edit = false, changes = false } = {}) {
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [] })
  session.append('turn/start', { turn: number })
  session.append('step/start', { turn: number, step: 1 })
  if (number === 1) session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'be helpful' }] } }, { surfaceOp: 'append' })
  const message = session.append('user/message', human(content), { surfaceOp: 'append' })
  if (edit) session.append('tool/call', { turn: number, step: 1, callId: `c${number}`, name: 'write', arguments: '{}' })
  session.append('assistant/message', { turn: number, step: 1, message: reply(`answer ${number}`), stream: [] }, { surfaceOp: 'append' })
  if (changes) session.append('workspace/changes', { turn: number })
  session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
  return message
}

/** Drive the two hooks the loop runs for the next step, as `ReactLoopAgent.turn/step` do. */
async function step(ctx, agent, number, messages) {
  agent.session.append('turn/start', { turn: number })
  agent.session.append('step/start', { turn: number, step: 1 })
  await ctx.waterfall('agent/pre-step', { agent, messages, turn: number, step: 1, signal }, () => Promise.resolve({ kind: 'enter', messages }))
  await ctx.waterfall('agent/request', { agent, turn: number, step: 1, signal }, () => Promise.resolve({ provider: 'p', model: 'm' }))
  for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
}

const surfaceTexts = session => session.surface.nodes.map(seq => {
  const event = session.eventAt(seq)
  const content = event.data.message?.content ?? event.data.content
  return `${event.type}:${content.map(block => block.text ?? block.type).join('')}`
})

test('inspect reports text, attachments, later messages, and workspace edits after the message', async () => {
  const { session, service, descriptors } = await setup()
  assert.equal(descriptors.length, 1)
  const first = turn(session, 1, [
    { type: 'text', text: 'please ' },
    { type: 'image', attachment: { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: image.length, width: 1, height: 1, name: 'shot.png' } },
    { type: 'file', attachment: { attachmentId: 'b'.repeat(64), name: 'report.txt', bytes: file.length } },
    { type: 'text', text: 'edit' },
  ], { edit: true, changes: true })
  const second = turn(session, 2, [{ type: 'text', text: 'second' }])

  const info = await service.inspect({ sessionId: 's1', seq: first.seq }, signal)
  assert.equal(info.refusal, null)
  assert.equal(info.text, 'please edit')
  assert.deepEqual(info.attachments.map(item => [item.kind, item.name, item.available]), [['image', 'shot.png', true], ['file', 'report.txt', true]])
  assert.deepEqual(info.modified, { turns: 1, edits: 1 })
  assert.equal(info.laterMessages, 1)

  const latest = await service.inspect({ sessionId: 's1', seq: second.seq }, signal)
  assert.deepEqual(latest.modified, { turns: 0, edits: 0 }, 'edits before the message do not count')
  assert.equal(latest.laterMessages, 0)

  const png = await service.attachment({ sessionId: 's1', seq: first.seq, index: 0 }, signal)
  assert.equal(Buffer.from(png.data, 'base64').toString(), image.toString())
  const report = await service.attachment({ sessionId: 's1', seq: first.seq, index: 1 }, signal)
  assert.equal(Buffer.from(report.data, 'base64').toString(), file.toString())

  const assistantSeq = session.surface.nodes.find(seq => session.eventAt(seq).type === 'assistant/message')
  assert.equal((await service.inspect({ sessionId: 's1', seq: assistantSeq }, signal)).refusal, 'not-user')
  assert.equal((await service.inspect({ sessionId: 's1', seq: 0 }, signal)).refusal, 'missing')
})

test('edit: arming withdraws nothing until the next human message, which replaces the target in place', async () => {
  const { ctx, session, service, agent } = await setup()
  turn(session, 1, [{ type: 'text', text: 'first' }])
  const second = turn(session, 2, [{ type: 'text', text: 'second' }], { changes: true })
  turn(session, 3, [{ type: 'text', text: 'third' }])

  // Edits after the target need an acknowledged warning.
  const refused = await service.arm({ sessionId: 's1', seq: second.seq, knownModified: false }, signal)
  assert.equal(refused.status, 'confirm')
  assert.deepEqual(refused.inspection.modified, { turns: 1, edits: 0 })

  const armed = await service.arm({ sessionId: 's1', seq: second.seq, knownModified: true }, signal)
  assert.deepEqual(armed, { status: 'armed', armed: { seq: second.seq, lastSeq: session.seq - 1 } })
  assert.deepEqual(await service.state({ sessionId: 's1' }), { armed: armed.armed })
  assert.equal(surfaceTexts(session).length, 7)
  const lastNode = session.surface.nodes.at(-1)

  // Runtime context alone does not consume the arm.
  await ctx.waterfall('agent/pre-step', { agent, messages: [createUserMessage({ content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } })], turn: 9, step: 9, signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.notEqual((await service.state({ sessionId: 's1' })).armed, null)

  await step(ctx, agent, 4, [human([{ type: 'text', text: 'second, edited' }], 'rpc-edit')])
  assert.deepEqual(surfaceTexts(session), [
    'system/message:be helpful', 'user/message:first', 'assistant/message:answer 1',
    'system/message:', 'user/message:second, edited',
  ])
  const marker = session.snapshotEvents().find(event => event.type === 'system/message' && event.data.message.content.length === 0)
  assert.deepEqual(marker.surfaceOp, { op: 'replace', startSeq: second.seq, endSeq: lastNode })
  assert.equal(marker.data.turn, 4)
  assert.deepEqual(await service.state({ sessionId: 's1' }), { armed: null })
})

test('disarm cancels a pending edit; later messages go out unchanged', async () => {
  const { ctx, session, service, agent } = await setup()
  const first = turn(session, 1, [{ type: 'text', text: 'first' }])
  turn(session, 2, [{ type: 'text', text: 'second' }])
  await service.arm({ sessionId: 's1', seq: first.seq, knownModified: false }, signal)
  await service.disarm({ sessionId: 's1' })
  await step(ctx, agent, 3, [human([{ type: 'text', text: 'third' }])])
  assert.equal(surfaceTexts(session).length, 6)
  assert.ok(!session.snapshotEvents().some(event => event.type === 'system/message' && event.data.message.content.length === 0))
})

test('retry: sends the original content with its durable attachments (and the note), replacing the target', async () => {
  const { ctx, session, service, agent } = await setup()
  turn(session, 1, [{ type: 'text', text: 'first' }])
  const attachment = { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' }
  const last = turn(session, 2, [{ type: 'text', text: 'draw' }, { type: 'image', attachment }], { edit: true })
  agent.status = 'running'

  const refused = await service.retry({ sessionId: 's1', seq: last.seq, knownModified: false, note: null }, signal)
  assert.equal(refused.status, 'confirm', 'stopping surfaced an edit the client had not warned about')
  assert.equal(agent.cancels, 1)
  assert.equal(agent.sent.length, 0)

  const sent = await service.retry({ sessionId: 's1', seq: last.seq, knownModified: true, note: 'NOTE' }, signal)
  assert.deepEqual(sent, { status: 'sent' })
  const [message] = agent.sent
  assert.deepEqual(message.content, [{ type: 'text', text: 'draw' }, { type: 'image', attachment }, { type: 'text', text: '\n\nNOTE' }])
  assert.equal(message.source.kind, 'user')
  assert.match(message.source.rpcId, /^message-rewind:/)

  await step(ctx, agent, 3, [message])
  assert.deepEqual(surfaceTexts(session), [
    'system/message:be helpful', 'user/message:first', 'assistant/message:answer 1',
    'system/message:', 'user/message:drawimage\n\nNOTE',
  ])
})

test('refusals and a missing agent are errors, not rewinds', async () => {
  const { session, service } = await setup()
  turn(session, 1, [{ type: 'text', text: 'only' }])
  const reply = session.surface.nodes.at(-1)
  await assert.rejects(service.arm({ sessionId: 's1', seq: reply, knownModified: true }, signal), /只能回退你发送的消息/)
  await assert.rejects(service.inspect({ sessionId: 'nope', seq: 1 }, signal), /会话未加载/)
  assert.equal(Plugin.refusalOf(session, session.surface.nodes[0]), 'head')
})
