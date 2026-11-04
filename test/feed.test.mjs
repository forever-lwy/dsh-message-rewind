import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FeedRegistry, SessionFeed, hidingCss, rewindRange } from '../lib/client/feed.js'

let seq = 0
const ev = (type, data = {}, extra = {}) => ({ type, seq: seq++, time: 0, data, ...extra })
const user = text => ev('user/message', { id: `u${seq}`, content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r' } }, { surfaceOp: 'append' })
const reply = turn => ev('assistant/message', { turn, step: 1, message: { content: [] } }, { surfaceOp: 'append' })
const marker = (turn, startSeq, endSeq) => ev('system/message', { turn, step: 1, message: { content: [] } }, { surfaceOp: { op: 'replace', startSeq, endSeq } })

/** Three closed turns, then turn 4 whose marker withdrew turn 2 onwards. */
function log() {
  seq = 0
  const events = [ev('turn/start', { turn: 1 }), ev('system/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' }), user('one'), reply(1), ev('turn/end', { turn: 1 })]
  events.push(ev('agent/inbox/spliced', {}), ev('turn/start', { turn: 2 }))
  const two = user('two')
  events.push(two, reply(2), ev('turn/end', { turn: 2 }), ev('turn/start', { turn: 3 }), user('three'), reply(3))
  const steered = user('steered')
  events.push(steered, reply(3), ev('turn/end', { turn: 3 }))
  return { events, two, steered }
}

test('a marker withdraws from the opening of the target turn up to the replacing turn', () => {
  const { events, two } = log()
  const start4 = ev('turn/start', { turn: 4 })
  const mark = marker(4, two.seq, events.at(-2).seq)
  events.push(start4, mark, user('two, edited'))
  const range = rewindRange(events, events.indexOf(mark))
  assert.deepEqual(range, { from: two.seq - 1, to: start4.seq, target: two.seq }, 'from turn 2 start to turn 4 start')
  assert.equal(rewindRange(events, events.indexOf(start4)), null)
})

test('a steered target withdraws from the message itself; normalization of a system node is ignored', () => {
  const { events, steered } = log()
  const start4 = ev('turn/start', { turn: 4 })
  const mark = marker(4, steered.seq, events.at(-2).seq)
  events.push(start4, mark)
  assert.deepEqual(rewindRange(events, events.indexOf(mark)), { from: steered.seq, to: start4.seq, target: steered.seq })
  const normalize = marker(4, 1, 1)
  events.push(normalize)
  assert.equal(rewindRange(events, events.indexOf(normalize)), null)
  // dsh-rewind-plugin's marker is a user message; it hides itself too.
  const legacy = ev('user/message', { content: [{ type: 'text', text: '(empty message)' }], source: { kind: 'dsh-rewind' } }, { surfaceOp: { op: 'replace', startSeq: steered.seq, endSeq: normalize.seq } })
  events.push(legacy)
  assert.deepEqual(rewindRange(events, events.indexOf(legacy)), { from: steered.seq, to: legacy.seq + 1, target: steered.seq })
})

function chat(nodes, turns) {
  return {
    order: nodes.map(node => node.key),
    nodes: { values: () => nodes },
    timeline: { turnOrder: Object.keys(turns).map(Number) },
    locations: { getTurn: turn => turns[turn] ?? [] },
  }
}

test('css hides whole turns and, inside a partly withdrawn turn, single nodes', () => {
  const starts = new Map([[1, 0], [2, 6], [3, 10], [4, 20]])
  const nodes = [
    { key: 'u1', anchorSeq: 2, data: { seq: 2 } }, { key: 'a1', anchorSeq: 3 },
    { key: 'u2', anchorSeq: 7, data: { seq: 7 } }, { key: 'a2', anchorSeq: 8 },
    { key: 'u3', anchorSeq: 11, data: { seq: 11 } }, { key: 's3', anchorSeq: 13, data: { seq: 13 } }, { key: 'a3', anchorSeq: 14 },
    { key: 'u4', anchorSeq: 22, data: { seq: 22 } },
  ]
  const snapshot = chat(nodes, { 1: ['u1', 'a1'], 2: ['u2', 'a2'], 3: ['u3', 's3', 'a3'], 4: ['u4'] })
  const css = hidingCss('s"1', [{ from: 6, to: 10, target: 7 }, { from: 13, to: 20, target: 13 }], starts, snapshot)
  assert.equal(css, [
    '[data-conversation-session="s\\"1"] [data-chat-turn="2"]',
    '[data-conversation-session="s\\"1"] [data-chat-node-key="s3"]',
    '[data-conversation-session="s\\"1"] [data-chat-node-key="a3"]',
  ].join(',\n') + ' { display: none !important; }\n')
  // A pending edit keeps its own message (the undo notice) visible.
  const pending = hidingCss('s1', [{ from: 6, to: 30, target: 7, keep: 7 }], starts, snapshot)
  assert.ok(!pending.includes('"u2"') && !pending.includes('data-chat-turn="2"'))
  assert.ok(pending.includes('"a2"') && pending.includes('data-chat-turn="3"') && pending.includes('data-chat-turn="4"'))
  assert.equal(hidingCss('s1', [], starts, snapshot), '')
})

function source(entries) {
  const listeners = new Set()
  let window = { entries: entries.map(event => ({ type: 'event', event })), revision: 1, change: { kind: 'replace' } }
  return {
    getSnapshot: () => window,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    append(event) {
      window = { entries: [...window.entries, { type: 'event', event }], revision: window.revision + 1, change: { kind: 'append', entries: [{ type: 'event', event }] } }
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

test('the feed reads only appended entries, clears a consumed pending edit, and keeps one stylesheet current', async () => {
  const { events, two } = log()
  const events$ = source(events)
  const css = []
  let chatListeners = 0
  const chat$ = { getSnapshot: () => ({ order: [] }), subscribe: () => { chatListeners++; return () => { chatListeners-- } } }
  const feed = new SessionFeed('s1', { events: events$, chat: chat$, state: async () => ({ armed: null }), writeCss: text => css.push(text) })
  assert.deepEqual(feed.hiddenRanges(), [])
  assert.equal(chatListeners, 0, 'no Chat subscription without a rewind')

  feed.setArmed({ seq: two.seq, lastSeq: events.at(-1).seq })
  assert.equal(feed.armedSeq(), two.seq)
  assert.equal(feed.isHidden(two.seq), false, 'the pending message shows the undo notice')
  assert.equal(feed.isHidden(two.seq + 3), true)
  assert.equal(chatListeners, 1)

  // A streaming chunk without a marker changes nothing.
  const revision = feed.getRevision()
  events$.append(ev('turn/start', { turn: 4 }))
  assert.equal(feed.getRevision(), revision)

  events$.append(marker(4, two.seq, events.at(-2).seq))
  assert.equal(feed.armedSeq(), null)
  assert.deepEqual(feed.hiddenRanges().map(range => range.target), [two.seq])
  assert.equal(feed.isHidden(two.seq), true)
  assert.ok(css.at(-1).includes('[data-conversation-session="s1"]'))

  feed.dispose()
  assert.equal(css.at(-1), '')
  assert.equal(events$.listeners.size, 0)
  assert.equal(chatListeners, 0)
})

test('the registry keeps a feed while rows hold it and disposes it after the grace period', async () => {
  let created = 0
  let disposed = 0
  const registry = new FeedRegistry(() => { created++; return { dispose: () => { disposed++ } } }, 5)
  const feed = registry.ensure('s1')
  assert.equal(registry.acquire('s1'), feed)
  registry.acquire('s1')
  registry.release('s1')
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(disposed, 0)
  registry.release('s1')
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(disposed, 1)
  assert.equal(registry.peek('s1'), undefined)
  registry.ensure('s2')
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(disposed, 2, 'an unheld feed lapses too')
  assert.equal(created, 2)
})
