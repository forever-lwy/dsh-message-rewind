import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RewindController } from '../lib/client/controller.js'

const info = (overrides = {}) => ({
  sessionId: 'src', seq: 21, refusal: null, text: 'edit me',
  attachments: [
    { kind: 'image', name: 'shot.png', bytes: 3, mediaType: 'image/png', available: true },
    { kind: 'file', name: 'report.txt', bytes: 5, available: true },
    { kind: 'file', name: 'huge.bin', bytes: 1e9, available: false },
  ],
  modified: { turns: 0, edits: 0 }, laterMessages: 0, running: false,
  ...overrides,
})

function harness({ armStatus = 'armed' } = {}) {
  const log = []
  let draftSeq = 0
  const feed = { setArmed: armed => log.push(`feed:${armed === null ? 'null' : armed.seq}`) }
  const deps = {
    remote: {
      inspect: async target => info(target),
      attachment: async ({ index }) => { log.push(`attachment:${index}`); return { name: index === 0 ? 'shot.png' : 'report.txt', mediaType: index === 0 ? 'image/png' : 'application/octet-stream', data: Buffer.from(`data${index}`).toString('base64') } },
      arm: async request => {
        log.push(`arm:${request.seq}:${request.knownModified}`)
        return armStatus === 'armed' ? { status: 'armed', armed: { seq: request.seq, lastSeq: 40 } } : { status: 'confirm', inspection: info({ modified: { turns: 1, edits: 0 } }) }
      },
      disarm: async () => { log.push('disarm'); return { ok: true } },
      retry: async request => { log.push(`retry:${request.seq}:${request.knownModified}:${request.note}`); return { status: 'sent' } },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: { src: { running: false } } }) },
      scope: id => ({ id }),
    },
    conversation: {
      input: {
        for: scope => ({
          setDraft: text => log.push(`setDraft:${scope.id}:${text}`),
          addAttachments: ids => { log.push(`addAttachments:${ids.join(',')}`); return true },
          focus: () => log.push('focus'),
        }),
      },
      createDrafts: (sessionId, files) => {
        log.push(`createDrafts:${sessionId}:${files.map(file => `${file.name}/${file.type || '-'}/${file.size}`).join(',')}`)
        return files.map(() => ({ id: `d${++draftSeq}` }))
      },
    },
    feed: () => feed,
  }
  return { log, controller: new RewindController(deps) }
}

test('edit: read attachments, arm, mark the pending edit, refill the composer with text, note, and attachments', async () => {
  const { log, controller } = harness()
  const outcome = await controller.run('src', info(), 'edit', { knownModified: true, note: 'NOTE' })
  assert.deepEqual(log, [
    'attachment:0', 'attachment:1',
    'arm:21:true',
    'feed:21',
    'setDraft:src:edit me\n\nNOTE',
    'createDrafts:src:shot.png/image/png/5,report.txt/-/5',
    'addAttachments:d1,d2',
    'focus',
  ])
  assert.equal(outcome.status, 'done')
  assert.deepEqual(outcome.notices.map(notice => notice.key), ['attachmentFailed'], 'the oversized file is reported')
})

test('edit: a confirm from the Host (edits surfaced by stopping) changes nothing in the composer', async () => {
  const { log, controller } = harness({ armStatus: 'confirm' })
  const outcome = await controller.run('src', info({ attachments: [] }), 'edit', { knownModified: false, note: null })
  assert.equal(outcome.status, 'confirm')
  assert.deepEqual(log, ['arm:21:false'])
})

test('retry passes the note and acknowledgement; undo disarms and clears the pending mark', async () => {
  const { log, controller } = harness()
  assert.deepEqual(await controller.run('src', info(), 'retry', { knownModified: false, note: null }), { status: 'done', notices: [] })
  await controller.undo('src')
  assert.deepEqual(log, ['retry:21:false:null', 'disarm', 'feed:null'])
})

test('a second rewind of the same Session while one runs is refused', async () => {
  const { controller } = harness()
  const first = controller.run('src', info({ attachments: [] }), 'edit', { knownModified: false, note: null })
  await assert.rejects(controller.run('src', info({ attachments: [] }), 'edit', { knownModified: false, note: null }), /already in progress/)
  await first
})
