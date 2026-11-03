import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Plugin from '../lib/index.js'

const signal = new AbortController().signal

// The loader passes (ctx, config) only; the store follows DSH_HOME as in production.
async function home(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix))
  process.env.DSH_HOME = join(base, 'dsh-home')
  return base
}
const storeOf = base => join(base, 'dsh-home', 'storages', 'dsh-message-rewind')

async function setup() {
  const base = await home('dmr-host-')
  const work = join(base, 'work')
  await mkdir(work)
  await writeFile(join(work, 'app.js'), 'v1')
  const ctx = new Context()
  const descriptors = []
  ctx.provide('typert', {
    lookups: { register: () => () => {} },
    contexts: { registerHost: () => () => {} },
    remotes: { register: info => { descriptors.push(info); return () => {} } },
  })
  const image = Buffer.from('fake-png-bytes')
  const file = Buffer.from('report body')
  ctx.provide('attachments', {
    readImage: async ref => ({ ref, data: new Uint8Array(image) }),
    readFileStream: async function* () { yield new Uint8Array(file.subarray(0, 4)); yield new Uint8Array(file.subarray(4)) },
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Plugin, { maxFiles: 1000 })
  await fiber
  return { base, work, ctx, descriptors, image, file, fiber }
}

const human = (content, id) => createUserMessage({ content, source: { kind: 'user' }, ...(id ? { id } : {}) })

test('records a checkpoint per human message, gates tools, restores, undoes, and follows fork lineage', async () => {
  const { base, work, ctx, descriptors, image, file, fiber } = await setup()
  try {
    assert.equal(descriptors.length, 1)
    assert.ok(ctx.get('messageRewind') instanceof Plugin.MessageRewindService)
    const service = ctx.messageRewind
    const session = ctx.sessions.create(SessionId('source-session'), { meta: { cwd: work, agentPreset: 'standard' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const runtime = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } }), { surfaceOp: 'append' })
    const first = session.append('user/message', human([
      { type: 'text', text: 'please edit ' },
      { type: 'image', attachment: { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: image.length, width: 1, height: 1, name: 'shot.png' } },
      { type: 'file', attachment: { attachmentId: 'b'.repeat(64), name: 'report.txt', bytes: file.length } },
      { type: 'text', text: 'app.js' },
    ]), { surfaceOp: 'append' })

    // A tool waits for the checkpoint; when it runs, the file is still v1 in the checkpoint.
    let gateResolved = false
    const gate = ctx.waterfall('tools/pre-execute', { agent: { session } }, () => Promise.resolve({ kind: 'allow' })).then(result => { gateResolved = true; return result })
    assert.deepEqual(await gate, { kind: 'allow' })
    assert.ok(gateResolved)
    await writeFile(join(work, 'app.js'), 'v2 edited by the agent')
    await writeFile(join(work, 'new.js'), 'created by the agent')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const records = await readdir(join(storeOf(base), 'sessions', 'source-session'))
    assert.deepEqual(records, [`m-${first.seq}.json`], 'runtime context is not a rewind target')
    assert.ok(runtime.seq < first.seq)

    const info = await service.inspect({ sessionId: 'source-session', seq: first.seq }, signal)
    assert.equal(info.boundary, null, 'nothing precedes the first message')
    assert.equal(info.text, 'please edit app.js')
    assert.deepEqual(info.attachments.map(item => [item.kind, item.name, item.available]), [['image', 'shot.png', true], ['file', 'report.txt', true]])
    assert.equal(info.checkpoint.files, 1)
    assert.equal(info.cwd, work)
    assert.equal(info.agentPreset, 'standard')
    assert.deepEqual(info.settings, { restoreFiles: true, archiveSource: true })

    const shot = await service.attachment({ sessionId: 'source-session', seq: first.seq, index: 0 }, signal)
    assert.equal(Buffer.from(shot.data, 'base64').toString(), image.toString())
    assert.equal(shot.mediaType, 'image/png')
    const report = await service.attachment({ sessionId: 'source-session', seq: first.seq, index: 1 }, signal)
    assert.equal(Buffer.from(report.data, 'base64').toString(), file.toString())

    const restored = await service.restore({ sessionId: 'source-session', seq: first.seq }, signal)
    assert.equal(restored.restored, true)
    assert.equal(await readFile(join(work, 'app.js'), 'utf8'), 'v1')
    await assert.rejects(readFile(join(work, 'new.js')))
    assert.match(restored.backupId, /^backup-/)

    const undone = await service.undo({ sessionId: 'source-session', backupId: restored.backupId }, signal)
    assert.equal(undone.restored, true)
    assert.equal(await readFile(join(work, 'app.js'), 'utf8'), 'v2 edited by the agent')
    assert.equal(await readFile(join(work, 'new.js'), 'utf8'), 'created by the agent')

    // Second message; then a fork child inherits both, and resolves the first through lineage.
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    const second = session.append('user/message', human([{ type: 'text', text: 'second' }]), { surfaceOp: 'append' })
    await service.settled('source-session')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const secondInfo = await service.inspect({ sessionId: 'source-session', seq: second.seq }, signal)
    assert.equal(secondInfo.boundary, first.seq + 1, 'keeps turn 1 through its turn/end')

    const child = ctx.sessions.fork(session, secondInfo.boundary, SessionId('child-session'))
    await service.link({ childId: child.id, sourceId: 'source-session', boundary: secondInfo.boundary }, signal)
    const inherited = await service.inspect({ sessionId: 'child-session', seq: first.seq }, signal)
    assert.equal(inherited.checkpoint.ownerSessionId, 'source-session')
    await assert.rejects(service.inspect({ sessionId: 'child-session', seq: second.seq }, signal), /找不到/)

    // Bad input never reaches the filesystem.
    await assert.rejects(service.inspect({ sessionId: '../escape', seq: 1 }, signal))
    await assert.rejects(service.undo({ sessionId: 'source-session', backupId: '../../x' }, signal))

    // Expired Sessions and their blobs are collected.
    const old = new Date(Date.now() - 40 * 86_400_000)
    const dir = join(storeOf(base), 'sessions', 'source-session')
    for (const name of await readdir(dir)) await utimes(join(dir, name), old, old)
    const collected = await service.collect()
    assert.equal(collected.sessions, 1)
    assert.ok(collected.objects >= 2)

    await fiber.dispose()
    assert.equal(ctx.get('messageRewind'), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('disabled recording still allows a chat-only rewind', async () => {
  const base = await home('dmr-host-off-')
  const ctx = new Context()
  try {
    ctx.provide('typert', { lookups: { register: () => () => {} }, contexts: { registerHost: () => () => {} }, remotes: { register: () => () => {} } })
    ctx.provide('attachments', {})
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(Plugin, { enabled: false })
    const session = ctx.sessions.create(SessionId('off-session'), { meta: { cwd: base } })
    session.append('turn/start', { turn: 1 })
    const message = session.append('user/message', human([{ type: 'text', text: 'hi' }]), { surfaceOp: 'append' })
    const info = await ctx.messageRewind.inspect({ sessionId: 'off-session', seq: message.seq }, signal)
    assert.equal(info.checkpoint, null)
    const result = await ctx.messageRewind.restore({ sessionId: 'off-session', seq: message.seq }, signal)
    assert.equal(result.restored, false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
