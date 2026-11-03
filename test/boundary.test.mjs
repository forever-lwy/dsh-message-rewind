import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForkSeed } from '@deepseek-ai/dsh-session'
import { forkBoundary, isHumanMessage, pendingInboxIds } from '../lib/boundary.js'

/** Build a log with contiguous seqs from compact rows, matching the rc.5 event order. */
function log(rows) {
  return rows.map(([type, data = {}], seq) => ({ type, seq, time: 1000 + seq, data }))
}
const human = (id, text) => ['user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }]
const context = text => ['user/message', { id: `ctx-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context' } }]
const queued = (id, start = 0, target = 'next-turn') => ['agent/inbox/spliced', { target, start, inserted: [{ id, role: 'user', content: [], source: { kind: 'user' } }] }]
const claimed = () => ['agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }]
const assistant = (turn, step = 1) => ['assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }]

// Mirrors a real rc.5 session: header events, two idle-sent turns, and a
// third message typed while turn 2 was still running.
const events = log([
  ['permission/preset'], ['sandbox/mode'], ['approval/policy'], ['session/title'], // 0-3
  queued('m1'), // 4
  ['turn/start', { turn: 1 }], claimed(), ['step/start', { turn: 1, step: 1 }], // 5-7
  ['system/message'], human('m1', 'first'), context('cwd'), // 8-10
  assistant(1), ['step/end'], ['turn/end', { turn: 1, reason: { kind: 'completed' } }], // 11-13
  ['command/run'], ['compaction/summary'], ['command/done'], // 14-16
  queued('m2'), ['turn/start', { turn: 2 }], claimed(), ['step/start', { turn: 2, step: 1 }], // 17-20
  human('m2', 'second'), assistant(2), // 21-22
  queued('m3'), // 23: typed while turn 2 runs
  queued('s1', 0, 'next-step'), ['tool/call', { callId: 'c1', turn: 2, step: 1 }], ['tool/result', { turn: 2, step: 1, message: { role: 'tool', content: [], source: { callId: 'c1' } } }], ['step/end'], // 24-27 (s1 steers later)
  ['step/start', { turn: 2, step: 2 }], ['agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }], // 28-29
  human('s1', 'steer'), assistant(2, 2), ['step/end'], ['turn/end', { turn: 2, reason: { kind: 'completed' } }], // 30-33
  ['turn/start', { turn: 3 }], claimed(), ['step/start', { turn: 3, step: 1 }], human('m3', 'third'), // 34-37
])

test('only human-authored user/message events count', () => {
  assert.equal(isHumanMessage(events[9]), true)
  assert.equal(isHumanMessage(events[10]), false)
  assert.equal(isHumanMessage(events[11]), false)
})

test('an opening message cuts before its turn and the splices that delivered it', () => {
  assert.equal(forkBoundary(events, 9), 3, 'first message keeps only the header events')
  assert.equal(forkBoundary(events, 21), 16, 'keeps the completed turn 1 and the manual compaction')
  assert.deepEqual(pendingInboxIds(events, 3), [])
  assert.deepEqual(pendingInboxIds(events, 16), [])
})

test('a message queued during the previous turn is inherited and reported for removal', () => {
  assert.equal(forkBoundary(events, 37), 33)
  assert.deepEqual(pendingInboxIds(events, 33), ['m3'])
})

test('a steered message cuts right before itself inside the running turn', () => {
  assert.equal(forkBoundary(events, 30), 29)
  assert.deepEqual(pendingInboxIds(events, 29), ['m3'])
})

test('nothing before the first message means a fresh Session', () => {
  const bare = log([queued('m1'), ['turn/start', { turn: 1 }], claimed(), ['step/start'], human('m1', 'x')])
  assert.equal(forkBoundary(bare, 4), null)
})

test('the real rc.5 fork seed at the computed boundary ends on a closed turn', () => {
  const seed = buildForkSeed(events, forkBoundary(events, 21))
  const types = seed.map(event => event.type)
  assert.equal(types.at(-1), 'session/end-seed', 'no synthetic closers were needed')
  assert.equal(types.filter(type => type === 'turn/start').length, types.filter(type => type === 'turn/end').length)
  const steeringSeed = buildForkSeed(events, forkBoundary(events, 30))
  assert.ok(steeringSeed.slice(-3).some(event => event.type === 'turn/end'), 'a mid-turn cut is closed by the Host')
})
