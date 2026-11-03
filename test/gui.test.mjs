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
    sessionId: 's1', seq: 9, boundary: 3, inheritedQueue: [], text: 'hello', attachments: [],
    checkpoint: { createdAt: 1, files: 12, skipped: 0, truncated: false, ownerSessionId: 's1' },
    cwd: '/workspace', agentPreset: null, settings: { restoreFiles: true, archiveSource: true }, ...overrides,
  }
}

function fakeController({ running = false, info = inspection(), outcome = { childId: 'c', notices: [] } } = {}) {
  const calls = []
  return {
    calls,
    isRunning: () => running,
    inspect: async (sessionId, seq) => { calls.push(['inspect', sessionId, seq]); return info },
    run: async (sessionId, value, mode, onStep) => { calls.push(['run', sessionId, value.seq, mode]); onStep('restoring'); return outcome },
  }
}

test('user rewind: confirm panel explains files, archive, and running stop; confirm runs the rewind', async () => {
  const controller = fakeController({ running: true })
  const face = { controller, t, Tooltip: modules['@deepseek-ai/dsh-client-ui-primitives'].Tooltip }
  const view = await render(React.createElement(client.UserRewindActions, { sessionId: 's1', seq: 9, face }))
  try {
    const action = view.container.querySelector('[data-rewind-mode="edit"]')
    assert.equal(action.getAttribute('aria-label'), zh.rewind)
    assert.ok(tooltips.includes(zh.rewind))
    await click(action)
    const panel = view.container.querySelector('.dmr-panel')
    assert.ok(panel.textContent.includes(zh.rewindTitle))
    assert.ok(panel.textContent.includes(zh.files.replace('{files}', '12')))
    assert.ok(panel.textContent.includes(zh.running))
    assert.ok(panel.textContent.includes(zh.archive))
    assert.equal(view.container.querySelector('.dmr-user-actions').hasAttribute('data-open'), true)
    await click(button(view.container, zh.confirmRewind))
    assert.deepEqual(controller.calls, [['inspect', 's1', 9], ['run', 's1', 9, 'edit']])
    assert.equal(view.container.querySelector('.dmr-panel'), null, 'closes after success')
  } finally { await view.unmount() }
})

test('warnings for missing checkpoints and failures are shown; cancel closes', async () => {
  const controller = fakeController({ info: inspection({ checkpoint: null, attachments: [{ kind: 'file', name: 'x', bytes: 1, available: false }] }),
    outcome: { childId: 'c', notices: [{ key: 'archiveFailed', values: { message: 'busy' } }] } })
  const view = await render(React.createElement(client.RewindButton, { sessionId: 's1', seq: 9, mode: 'edit', face: { controller, t } }))
  try {
    await click(view.container.querySelector('button'))
    const text = view.container.textContent
    assert.ok(text.includes(zh.noCheckpoint))
    assert.ok(text.includes(zh.attachmentsTooLarge.replace('{count}', '1')))
    await click(button(view.container, zh.cancel))
    assert.equal(view.container.querySelector('.dmr-panel'), null)
    await click(view.container.querySelector('button'))
    await click(button(view.container, zh.confirmRewind))
    assert.ok(view.container.textContent.includes(zh.archiveFailed.replace('{message}', 'busy')), 'non-fatal problems stay visible')
  } finally { await view.unmount() }
})

test('the user-node wrapper renders the current official renderer above its row and follows re-registration', async () => {
  const entries = []
  const listeners = new Set()
  const slots = {
    entries: () => entries,
    subscribe: (key, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const face = { controller: fakeController(), t }
  const Wrapper = client.createUserNodeRenderer(slots, face)
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
  } finally { await view.unmount() }
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
    assert.ok(visible.container.textContent.includes(zh.retryTitle))
    assert.equal(visible.container.querySelector('.dmr-panel').dataset.side, 'top')
    await click(button(visible.container, zh.confirmRetry))
    assert.deepEqual(controller.calls.at(-1), ['run', 's1', 9, 'retry'])
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
    slots, remote: {}, sessions: {}, conversation: {}, uiWorkspace: { openSession: () => {} },
    get: () => undefined,
  }
  const ctx = {
    remote: { $mount: async info => { assert.ok(info.methods['messageRewind/inspect']); return () => {} } },
    effect: (fn) => { effects.push(fn()) },
    locale: { register: () => () => {}, bind: () => t },
    inject: (deps, fn) => { assert.deepEqual(deps, ['remote.messageRewind', 'sessions', 'conversation', 'uiWorkspace']); fn(scoped) },
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
