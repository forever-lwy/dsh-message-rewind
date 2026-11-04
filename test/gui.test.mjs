import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, KeyboardEvent: dom.window.KeyboardEvent })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
const { createRoot } = await import('react-dom/client')
const { act } = React
const zod = await import('zod')
const { zh } = await import('../lib/client/locales.js')

// Load the shipped browser bundle exactly as the DSH module loader does.
let client
const tooltips = []
const modules = {
  react: React, 'react/jsx-runtime': jsxRuntime, zod,
  '@deepseek-ai/dsh-client-ui-primitives': {
    Tooltip: ({ label, children }) => { tooltips.push(label); return children },
    IconRefreshOutlineRegular: () => React.createElement('svg', { 'data-icon': 'refresh' }),
  },
}
window.__ModuleLoader__ = { load: ({ id, factory }) => { assert.equal(id, 'dsh-message-rewind'); client = factory(name => {
  if (!(name in modules)) throw new Error(`unexpected require ${name}`)
  return modules[name]
}) } }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
assert.ok(client, 'bundle registered itself')

const t = key => zh[key] ?? key
const click = element => act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const button = (container, text) => [...container.querySelectorAll('button')].find(node => node.textContent === text)
async function render(element) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  return { container, root, unmount: () => act(async () => root.unmount()) }
}

function inspection(overrides = {}) {
  return {
    sessionId: 's1', seq: 9, refusal: null, text: 'hello', attachments: [],
    modified: { turns: 0, edits: 0 }, laterMessages: 0, running: false, ...overrides,
  }
}

function fakeController({ info = inspection(), outcomes = [] } = {}) {
  const calls = []
  return {
    calls,
    isRunning: () => false,
    inspect: async (sessionId, seq) => { calls.push(['inspect', sessionId, seq]); return info },
    run: async (sessionId, value, mode, options) => { calls.push(['run', sessionId, value.seq, mode, options]); return outcomes.shift() ?? { status: 'done', notices: [] } },
    undo: async sessionId => { calls.push(['undo', sessionId]) },
  }
}

const faceOf = controller => ({ controller, t, Tooltip: modules['@deepseek-ai/dsh-client-ui-primitives'].Tooltip })

test('no workspace edits and nothing later: edit acts at once, without a dialog', async () => {
  const controller = fakeController()
  const view = await render(React.createElement(client.UserRewindActions, { sessionId: 's1', seq: 9, face: faceOf(controller) }))
  try {
    const action = view.container.querySelector('[data-rewind-mode="edit"]')
    assert.equal(action.getAttribute('aria-label'), zh.rewind)
    assert.ok(view.container.querySelector('[data-rewind-mode="retry"]'), 'regenerate sits beside it')
    await click(action)
    assert.deepEqual(controller.calls, [['inspect', 's1', 9], ['run', 's1', 9, 'edit', { knownModified: false, note: null }]])
    assert.equal(view.container.querySelector('.dmr-panel'), null)
  } finally { await view.unmount() }
})

test('workspace edits: the warning offers cancel, confirm, and confirm with the note', async () => {
  for (const [mode, label, note] of [['edit', zh.confirm, null], ['retry', zh.confirmWithNote, zh.noteRetry], ['edit', zh.confirmWithNote, zh.noteEdit]]) {
    const controller = fakeController({ info: inspection({ modified: { turns: 2, edits: 3 }, laterMessages: 1 }) })
    const view = await render(React.createElement(client.RewindButton, { sessionId: 's1', seq: 9, mode, face: faceOf(controller) }))
    try {
      await click(view.container.querySelector('button'))
      const panel = view.container.querySelector('.dmr-panel')
      assert.equal(panel.dataset.phase, 'warn')
      assert.ok(panel.textContent.includes(zh.warnTitle))
      assert.ok(panel.textContent.includes(zh.modifiedTurns.replace('{count}', '2')))
      assert.ok(panel.textContent.includes(zh.modifiedEdits.replace('{count}', '3')))
      assert.deepEqual([...panel.querySelectorAll('.dmr-buttons button')].map(node => node.textContent), [zh.cancel, zh.confirm, zh.confirmWithNote])
      await click(button(view.container, label))
      assert.deepEqual(controller.calls.at(-1), ['run', 's1', 9, mode, { knownModified: true, note }])
      assert.equal(view.container.querySelector('.dmr-panel'), null)
    } finally { await view.unmount() }
  }
  const controller = fakeController({ info: inspection({ modified: { turns: 1, edits: 0 } }) })
  const view = await render(React.createElement(client.RewindButton, { sessionId: 's1', seq: 9, mode: 'edit', face: faceOf(controller) }))
  try {
    await click(view.container.querySelector('button'))
    await click(button(view.container, zh.cancel))
    assert.equal(view.container.querySelector('.dmr-panel'), null)
    assert.equal(controller.calls.filter(call => call[0] === 'run').length, 0)
  } finally { await view.unmount() }
})

test('edits surfaced only after stopping re-open the warning; refusals and notices are shown', async () => {
  const controller = fakeController({ info: inspection({ running: true }), outcomes: [
    { status: 'confirm', inspection: inspection({ modified: { turns: 1, edits: 0 } }) },
    { status: 'done', notices: [{ key: 'attachmentFailed', values: { name: 'x', message: 'too large' } }] },
  ] })
  const view = await render(React.createElement(client.RewindButton, { sessionId: 's1', seq: 9, mode: 'retry', face: faceOf(controller) }))
  try {
    await click(view.container.querySelector('button'))
    assert.equal(view.container.querySelector('.dmr-panel').dataset.phase, 'confirm', 'a running task asks first')
    assert.ok(view.container.textContent.includes(zh.running))
    await click(button(view.container, zh.confirm))
    assert.equal(view.container.querySelector('.dmr-panel').dataset.phase, 'warn')
    await click(button(view.container, zh.confirmWithNote))
    assert.ok(view.container.textContent.includes('附件“x”未能回填'))
  } finally { await view.unmount() }
  const refused = await render(React.createElement(client.RewindButton, { sessionId: 's1', seq: 9, mode: 'edit', face: faceOf(fakeController({ info: inspection({ refusal: 'missing' }) })) }))
  try {
    await click(refused.container.querySelector('button'))
    assert.ok(refused.container.textContent.includes(zh['refusal.missing']))
  } finally { await refused.unmount() }
})

test('the user-node wrapper renders the current official renderer above its row and follows re-registration', async () => {
  const entries = []
  const listeners = new Set()
  const slots = {
    entries: () => entries,
    subscribe: (key, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const controller = fakeController()
  const face = { controller, t }
  // A real feed over a fake event window: seq 4 opens turn 1; a later marker withdraws seq 8.
  const feedListeners = new Set()
  let windowValue = { entries: [], revision: 0, change: { kind: 'replace' } }
  const events$ = { getSnapshot: () => windowValue, subscribe: fn => { feedListeners.add(fn); return () => feedListeners.delete(fn) } }
  const feeds = new client.FeedRegistry(id => new client.SessionFeed(id, { events: events$, chat: undefined, writeCss: () => {} }), 5)
  const Wrapper = client.createUserNodeRenderer(slots, face, feeds)
  const officialV1 = props => React.createElement('div', { 'data-official': 'v1' }, props.node.data.content[0].text)
  entries.push({ component: Wrapper, options: { key: 'user', priority: -10 } }, { component: officialV1, options: { key: 'user' } }, { component: () => null, options: { key: 'steering' } })
  const props = { node: { kind: 'user', data: { seq: 4, content: [{ type: 'text', text: 'bubble' }] } }, sessionId: 's1', useSession: select => select({ subagent: null }), t }
  const view = await render(React.createElement(Wrapper, props))
  try {
    assert.equal(view.container.querySelector('[data-official="v1"]').textContent, 'bubble')
    assert.ok(view.container.querySelector('.dmr-user-row[data-message-rewind-seq="4"] [data-rewind-mode="edit"]'))
    // HMR replaces the official entry; the wrapper picks up the new one.
    entries.splice(1, 1, { component: () => React.createElement('div', { 'data-official': 'v2' }), options: { key: 'user' } })
    await act(async () => { for (const listener of listeners) listener() })
    assert.ok(view.container.querySelector('[data-official="v2"]'))
    // A pending edit of this message shows the undo notice instead of the bubble.
    await act(async () => feeds.peek('s1').setArmed({ seq: 4, lastSeq: 10 }))
    assert.ok(view.container.textContent.includes(zh.armed))
    assert.equal(view.container.querySelector('[data-official]'), null)
    await click(button(view.container, zh.undoRewind))
    assert.deepEqual(controller.calls.at(-1), ['undo', 's1'])
    // A landed rewind hides the row.
    const entries2 = [{ type: 'turn/start', seq: 3, data: { turn: 1 } }, { type: 'user/message', seq: 4, data: { source: { kind: 'user' } } },
      { type: 'turn/start', seq: 11, data: { turn: 2 } }, { type: 'system/message', seq: 12, data: { turn: 2, message: { content: [] } }, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 10 } }]
    windowValue = { entries: entries2.map(event => ({ type: 'event', event })), revision: 1, change: { kind: 'replace' } }
    await act(async () => { feeds.peek('s1').setArmed(null); for (const fn of feedListeners) fn() })
    assert.equal(view.container.querySelector('.dmr-user-row'), null)
  } finally { await view.unmount(); feeds.dispose() }
  const subagent = await render(React.createElement(Wrapper, { ...props, useSession: select => select({ subagent: { address: 'x' } }) }))
  try {
    assert.equal(subagent.container.querySelector('[data-rewind-mode]'), null, 'subagent transcripts offer no rewind')
  } finally { await subagent.unmount() }
})

function chatSnapshot({ closingId = 'a2', lastKinds = ['user', 'assistant-step', 'steering'] } = {}) {
  const nodes = new Map(lastKinds.map((kind, index) => [`k${index}`, { kind, data: { seq: 40 + index } }]))
  return {
    timeline: { turnOrder: [1, 2], turns: new Map([[2, { data: { get: key => key === 'turn-tail' ? { closing: { finalNode: { messageId: closingId } } } : undefined } }]]) },
    locations: { getTurn: turn => turn === 2 ? [...nodes.keys()] : [] },
    nodes: { get: key => nodes.get(key) },
  }
}

test('retry targets the last human message of the last turn, only on its closing reply', () => {
  assert.equal(client.retryTarget(chatSnapshot(), 'a2'), 42, 'the steered message is the latest input')
  assert.equal(client.retryTarget(chatSnapshot({ lastKinds: ['user', 'assistant-step'] }), 'a2'), 40)
  assert.equal(client.retryTarget(chatSnapshot(), 'older'), null)
  assert.equal(client.retryTarget(chatSnapshot({ lastKinds: ['context', 'assistant-step'] }), 'a2'), null, 'trigger-only turns have no message to resend')
  assert.equal(client.retryTarget({}, 'a2'), null)
})

test('the retry action appears only on the latest settled reply', async () => {
  const controller = fakeController()
  const face = { controller, t, RetryIcon: modules['@deepseek-ai/dsh-client-ui-primitives'].IconRefreshOutlineRegular }
  const Retry = client.createRetryAction(face)
  const props = (state, messageId = 'a2') => ({ messageId, sessionId: 's1', useChat: select => select(chatSnapshot()), useSession: select => select(state) })
  const visible = await render(React.createElement(Retry, props({ running: false, subagent: null })))
  try {
    const action = visible.container.querySelector('[data-rewind-mode="retry"]')
    assert.ok(action.querySelector('[data-icon="refresh"]'))
    await click(action)
    assert.deepEqual(controller.calls.at(-1), ['run', 's1', 9, 'retry', { knownModified: false, note: null }], 'nothing to warn about: regenerate at once')
  } finally { await visible.unmount() }
  for (const [state, messageId] of [[{ running: true, subagent: null }, 'a2'], [{ running: false, subagent: null }, 'older']]) {
    const hidden = await render(React.createElement(Retry, props(state, messageId)))
    try { assert.equal(hidden.container.querySelector('button'), null) } finally { await hidden.unmount() }
  }
})

test('apply mounts the remote, shadows user/steering renderers below the official priority, and adds the retry action', async () => {
  const registrations = []
  const disposed = []
  const effects = []
  const slots = {
    entries: () => [], subscribe: () => () => {},
    inject: (key, fn) => { fn() },
    register: (options, component) => { registrations.push({ options, component }); return () => disposed.push(options) },
  }
  const scoped = {
    slots, remote: {}, sessions: { binding: () => undefined }, conversation: {}, uiConversation: { binding: () => ({ target: () => undefined }) },
    effect: fn => { effects.push(fn()) },
  }
  const ctx = {
    remote: { $mount: async info => { assert.ok(info.methods['messageRewind/inspect']); return () => {} } },
    effect: (fn) => { effects.push(fn()) },
    locale: { register: () => () => {}, bind: () => t },
    inject: (deps, fn) => { assert.deepEqual(deps, ['remote.messageRewind', 'sessions', 'conversation', 'uiConversation']); fn(scoped) },
  }
  await client.apply(ctx)
  assert.deepEqual(registrations.map(({ options }) => [options.name, options.key ?? options.id, options.priority, options.locale]), [
    ['conversation.chat.node', 'user', -10, 'chat'],
    ['conversation.chat.node', 'steering', -10, 'chat'],
    ['conversation.chat.assistant-actions', 'message-rewind.retry', undefined, undefined],
  ])
  assert.ok(document.head.querySelector('style[data-plugin="dsh-message-rewind"]'))
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  assert.equal(document.head.querySelector('style[data-plugin="dsh-message-rewind"]'), null)
})
