import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RewindController } from '../lib/client/controller.js'

const info = (overrides = {}) => ({
  sessionId: 'src', seq: 21, boundary: 16, inheritedQueue: ['m3'], text: 'edit me',
  attachments: [
    { kind: 'image', name: 'shot.png', bytes: 3, mediaType: 'image/png', available: true },
    { kind: 'file', name: 'report.txt', bytes: 5, available: true },
    { kind: 'file', name: 'huge.bin', bytes: 1e9, available: false },
  ],
  checkpoint: { createdAt: 1, files: 4, skipped: 0, truncated: false, ownerSessionId: 'src' },
  cwd: '/workspace', agentPreset: 'standard',
  settings: { restoreFiles: true, archiveSource: true },
  ...overrides,
})

function harness({ running = false, forkFails = false, uploads = 'ready' } = {}) {
  const log = []
  const state = { running }
  const scopes = { src: { conversation: { cancel: async () => { log.push('cancel'); state.running = false } } } }
  let draftSeq = 0
  const deps = {
    remote: {
      inspect: async target => info(target),
      attachment: async ({ index }) => { log.push(`attachment:${index}`); return { name: index === 0 ? 'shot.png' : 'report.txt', mediaType: index === 0 ? 'image/png' : 'application/octet-stream', data: Buffer.from(`data${index}`).toString('base64') } },
      restore: async target => { log.push(`restore:${target.seq}`); return { restored: true, written: 2, deleted: 1, unchanged: 3, failed: [], backupId: 'backup-1' } },
      undo: async ({ backupId }) => { log.push(`undo:${backupId}`); return { restored: true, written: 1, deleted: 0, unchanged: 0, failed: [], backupId: 'backup-2' } },
      link: async request => { log.push(`link:${request.childId}<-${request.sourceId}@${request.boundary}`); return { ok: true } },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: { src: { running: state.running } } }) },
      fork: async opts => { log.push(`fork:${opts.sessionId}@${opts.atSeq}:${opts.increaseTitle}`); if (forkFails) throw new Error('fork refused'); return 'child' },
      create: async opts => { log.push(`create:${opts.cwd}:${opts.agentPreset}`); return 'fresh' },
      retain: id => { log.push(`retain:${id}`); return { ready: Promise.resolve(), binding: { id }, release: () => log.push(`release:${id}`) } },
      scope: id => {
        if (scopes[id]) return scopes[id]
        return (scopes[id] = { conversation: { updateQueue: async (itemId, action) => { log.push(`queue:${itemId}:${action.kind}`) } } })
      },
    },
    conversation: {
      input: {
        for: scope => ({
          setDraft: text => log.push(`setDraft:${text}`),
          addAttachments: ids => { log.push(`addAttachments:${ids.join(',')}`); return true },
          submit: () => log.push('submit'),
        }),
        requestDraftInitialization: (binding, options) => { log.push(`draft:${binding.id}:${options.prompt}:${options.whenDraftExists}`); return 'applied' },
      },
      createDrafts: (sessionId, files) => {
        log.push(`createDrafts:${sessionId}:${files.map(file => `${file.name}/${file.type || '-'}/${file.size}`).join(',')}`)
        return files.map(file => ({ id: `d${++draftSeq}`, kind: file.type.startsWith('image/') ? 'image' : 'file' }))
      },
      fileUploads: { getSnapshot: () => ({ d2: { status: uploads } }) },
    },
    openSession: id => log.push(`open:${id}`),
    archiveSession: async id => { log.push(`archive:${id}`) },
    wait: async () => {},
  }
  return { log, controller: new RewindController(deps), state }
}

test('edit: restore, fork, drop inherited queue, refill composer with attachments, open, archive', async () => {
  const { log, controller } = harness()
  const steps = []
  const outcome = await controller.run('src', info(), 'edit', step => steps.push(step))
  assert.equal(outcome.childId, 'child')
  assert.deepEqual(log.filter(line => !line.startsWith('release')), [
    'attachment:0', 'attachment:1',
    'restore:21',
    'fork:src@16:false',
    'link:child<-src@16',
    'retain:child',
    'queue:m3:remove',
    'draft:child:edit me:replace',
    'createDrafts:child:shot.png/image/png/5,report.txt/-/5',
    'addAttachments:d1,d2',
    'open:child',
    'archive:src',
  ])
  assert.deepEqual(steps, ['restoring', 'forking', 'preparing'])
  assert.deepEqual(outcome.notices.map(notice => notice.key), ['attachmentFailed', 'restoredFiles'])
})

test('retry: stops a running source first, then sends once uploads are ready', async () => {
  const { log, controller } = harness({ running: true })
  const steps = []
  await controller.run('src', info({ attachments: [] }), 'retry', step => steps.push(step))
  assert.equal(log[0], 'cancel')
  assert.equal(log.filter(line => !line.startsWith('release')).at(-1), 'submit')
  assert.deepEqual(steps, ['stopping', 'restoring', 'forking', 'preparing', 'sending'])
})

test('first message starts a fresh Session in the same directory and preset', async () => {
  const { log, controller } = harness()
  const outcome = await controller.run('src', info({ boundary: null, inheritedQueue: [], attachments: [] }), 'edit')
  assert.equal(outcome.childId, 'fresh')
  assert.ok(log.includes('create:/workspace:standard'))
  assert.ok(log.includes('link:fresh<-src@null'))
})

test('a failed fork undoes the file restore and leaves the source untouched', async () => {
  const { log, controller } = harness({ forkFails: true })
  await assert.rejects(controller.run('src', info({ attachments: [] }), 'edit'), /fork refused/)
  assert.ok(log.includes('undo:backup-1'))
  assert.ok(!log.some(line => line.startsWith('archive') || line.startsWith('open')))
})

test('without a checkpoint or with restore off, files are not touched', async () => {
  for (const overrides of [{ checkpoint: null }, { settings: { restoreFiles: false, archiveSource: false } }]) {
    const { log, controller } = harness()
    await controller.run('src', info({ attachments: [], ...overrides }), 'edit')
    assert.ok(!log.some(line => line.startsWith('restore')))
    if (overrides.settings) assert.ok(!log.some(line => line.startsWith('archive')))
  }
})

test('a second rewind of the same source while one runs is refused', async () => {
  const { controller } = harness()
  const first = controller.run('src', info({ attachments: [] }), 'edit')
  await assert.rejects(controller.run('src', info({ attachments: [] }), 'edit'), /already in progress/)
  await first
})
