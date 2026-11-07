// The shipped lib/client.js shadows against the real slot renderer
// (@deepseek-ai/dsh-client-ui-renderer) in jsdom. The renderer retires an
// entry that throws while rendering, so a shadow the official bubble cannot
// render through silently loses every rewind row; the fake-slot tests in
// gui.test.mjs cannot see that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const w = dom.window
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'KeyboardEvent', 'MouseEvent', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
  if (w[key] !== undefined) Object.defineProperty(globalThis, key, { value: key === 'getComputedStyle' || key.endsWith('AnimationFrame') ? w[key].bind(w) : w[key], configurable: true, writable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = React
const h = React.createElement
const modules = {
  react: React,
  'react/jsx-runtime': await import('react/jsx-runtime'),
  'react-dom': await import('react-dom'),
  'react-dom/client': await import('react-dom/client'),
  zod: await import('zod'),
  '@deepseek-ai/cordis': await import('@deepseek-ai/cordis'),
  '@deepseek-ai/dsh-client-ui-slots': await import('@deepseek-ai/dsh-client-ui-slots'),
  '@deepseek-ai/dsh-client-ui-primitives': {},
}
const cordis = modules['@deepseek-ai/cordis']
const loaded = {}
w.__ModuleLoader__ = { load: ({ id, factory }) => { loaded[id] = factory(name => {
  if (!(name in modules)) throw new Error(`unexpected require ${name} from ${id}`)
  return modules[name]
}) } }
const load = path => new w.Function(readFileSync(path, 'utf8'))()
load(require.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json').replace(/package\.json$/, 'lib/client.js'))
load(new URL('../lib/client.js', import.meta.url))
const renderer = loaded['@deepseek-ai/dsh-client-ui-renderer']
const client = loaded['@forever-lwy/dsh-message-rewind']

const crashes = []
const consoleError = console.error
console.error = (...args) => { if (String(args[0]).includes('crashed')) crashes.push(args); else consoleError(...args) }

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, set: next => { value = next; for (const fn of [...listeners]) fn() } }
}

const NODE = 'conversation.chat.node'
const BEFORE = 'conversation.chat.user.before'
const ctx = new cordis.Context()
await ctx.plugin(renderer)
const dictionaries = { chat: { copy: '复制' }, live: { from: '来自 ' } }
const bind = ns => key => dictionaries[ns]?.[key] ?? `${ns}:${key}`
ctx.provide('locale'); ctx.set('locale', { register: () => () => {}, bind })
ctx.slots.installLocale({ ...observable({ revision: 0 }), bind })
const session = observable({ subagent: null, running: false })
const binding = { key: 's1', ctx, hooks: { session }, keyedHooks: {}, props: { sessionId: 's1' } }
ctx.slots.installScope('session', { current: observable(binding), bindingSource: () => observable(binding),
  renderArea: (value, { empty, children }) => value.key === undefined ? (empty?.() ?? null) : h(React.Fragment, null, children) })
ctx.slots.provideRoot({ hooks: {} })

const nodes = [
  { key: 'n1', kind: 'user', data: { seq: 4, source: { kind: 'user' }, text: 'first' } },
  { key: 'n2', kind: 'steering', data: { seq: 7, source: { kind: 'user' }, text: 'steered' } },
  { key: 'n3', kind: 'user', data: { seq: 9, source: { kind: 'user', author: 'Ann' }, text: 'shared' } },
]
function Flow({ renderSlot }) {
  return h('div', null, nodes.map(node => h('div', { key: node.key, 'data-chat-node-key': node.key }, renderSlot(NODE, { node }, { entryKey: node.kind }))))
}
ctx.slots.register({ name: 'root', children: { [NODE]: { kind: 'keyed', scope: 'session' } } }, Flow)

// Registered the way 0.2.2-rc.1 dsh-client-ui-chat registers its user renderers.
function UserBubble({ node, renderSlotChain, t }) {
  return h('div', { 'data-official': node.kind },
    renderSlotChain(BEFORE, { source: node.data.source, kind: node.kind }, { fallback: null }),
    h('span', { className: 'text' }, node.data.text),
    h('button', { className: 'copy' }, t('copy')))
}
await ctx.plugin({ name: 'official-chat', inject: ['slots'], apply(child) {
  child.slots.inject(NODE, () => child.slots.register({ name: NODE, key: 'user', locale: 'chat', children: { [BEFORE]: { kind: 'chain', scope: 'session' } } }, UserBubble))
  child.slots.inject(NODE, () => child.slots.register({ name: NODE, key: 'steering', locale: 'chat', inject: () => ({ renderSlotChain: () => null }) }, UserBubble))
} })
// Like liveshare's origin line: a chain entry with its own locale.
function Origin({ matched, t }) { return h('p', { className: 'origin' }, t('from') + matched) }
const liveshare = ctx.plugin({ name: 'liveshare', inject: ['slots'], apply(child) {
  child.slots.inject(BEFORE, () => child.slots.register({ name: BEFORE, locale: 'live', select: owner => owner.kind === 'user' ? owner.source.author ?? null : null }, Origin))
} })
await liveshare

const controller = { isRunning: () => false, inspect: async () => { throw new Error('unused') }, run: async () => ({ status: 'done', notices: [] }), undo: async () => {} }
const face = { controller, t: key => key }
const rewind = ctx.plugin({ name: 'rewind', inject: ['slots'], apply(child) {
  client.registerUserNodes(child.slots, client.createUserNodeRenderer(child.slots, face), -10)
} })
await rewind

const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const app = document.getElementById('app')
let unmount
await act(async () => { unmount = ctx.uiRenderer.mount(app) })
await tick(); await tick()
const row = key => app.querySelector(`[data-chat-node-key="${key}"]`)

test('user and steering bubbles render through the shadow with their rewind rows', () => {
  assert.deepEqual(crashes, [], 'no entry crashed (a crash retires the shadow)')
  assert.equal(app.querySelector('[data-slot-error]'), null)
  for (const [key, seq] of [['n1', 4], ['n2', 7], ['n3', 9]]) {
    const node = row(key)
    assert.ok(node.querySelector('[data-official] .text'), `${key}: official bubble`)
    assert.equal(node.querySelector('.copy').textContent, '复制', `${key}: official locale`)
    const actions = node.querySelector(`.dmr-user-row[data-message-rewind-seq="${seq}"] .dmr-user-actions`)
    assert.ok(actions, `${key}: rewind row`)
    assert.deepEqual([...actions.querySelectorAll('[data-rewind-mode]')].map(button => button.dataset.rewindMode), ['retry', 'edit'])
  }
})

test('the user.before chain still elects its entries, with their own locale', () => {
  assert.equal(row('n1').querySelector('.origin'), null, 'declined for an unshared message')
  assert.equal(row('n2').querySelector('.origin'), null, 'steering renders no chain')
  assert.equal(row('n3').querySelector('.origin').textContent, '来自 Ann')
})

test('the mirror follows the chain: an unloaded entry disappears, and the shadow goes with its plugin', async () => {
  await act(async () => { liveshare.dispose() })
  await tick(); await tick()
  assert.equal(row('n3').querySelector('.origin'), null)
  assert.ok(row('n3').querySelector('[data-rewind-mode="edit"]'))
  await act(async () => { rewind.dispose() })
  await tick(); await tick()
  assert.equal(app.querySelector('.dmr-user-row'), null)
  assert.equal(row('n1').querySelector('[data-official] .text').textContent, 'first', 'official renderer takes the cell back')
  assert.deepEqual(crashes, [])
  await act(async () => unmount?.())
})
