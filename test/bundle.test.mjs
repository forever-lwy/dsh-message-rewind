import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { officialRenderer } from '../lib/client/renderers.js'

const require = createRequire(import.meta.url)
const project = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function officialLayers() {
  return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].flatMap(name => {
    const path = require.resolve(name + '/package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(pkg.version, '0.2.2-rc.3')
    return [].concat(pkg.dsh.bundle.patch).map(patch => loadOverlayPatches('message-rewind-test', resolve(dirname(path), patch)))
  })
}

test('manifest declares the bundle patch, both entries, and no dsh version gate', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.engines.dsh, '*', 'never gate on the dsh version')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const peer of Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.match(manifest.peerDependencies[peer], /^>=/, peer)
  }
  assert.ok(manifest.files.includes('lib') && manifest.files.includes('cordis.patch.yml'))
})

test('the patch adds one root row beside workspace-changes and changes no official row', () => {
  const layers = officialLayers()
  const before = composeEntries(layers)
  const warnings = []
  const after = composeEntries([...layers, loadOverlayPatches('message-rewind-test', resolve(project, 'cordis.patch.yml'))], message => warnings.push(message))
  assert.deepEqual(warnings, [])
  const added = after.filter(row => !before.some(other => other.id === row.id))
  assert.deepEqual(added.map(row => [row.id, row.name]), [['message-rewind', '@forever-lwy/dsh-message-rewind']])
  assert.ok(after.some(row => row.id === 'workspace-changes'), 'the official recorder stays a sibling root row')
  for (const row of before) assert.deepEqual(after.find(other => other.id === row.id), row)
})

test('the real rc.5 slot registry lets the shadow win while keeping the official entry reachable', () => {
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } }, () => null)
  const official = () => null
  const shadow = () => null
  core.register({ name: 'conversation.chat.node', key: 'user', locale: 'chat' }, official)
  core.register({ name: 'conversation.chat.node', key: 'steering', locale: 'chat' }, official)
  const dispose = core.register({ name: 'conversation.chat.node', key: 'user', locale: 'chat', priority: -10 }, shadow)
  assert.equal(core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'user').component, shadow)
  assert.equal(officialRenderer(core, 'user', shadow), official)
  assert.equal(officialRenderer(core, 'steering', shadow), official)
  dispose()
  assert.equal(core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'user').component, official, 'unloading restores the official renderer')
})
