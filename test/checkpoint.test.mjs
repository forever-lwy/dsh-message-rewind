import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore, walk } from '../lib/checkpoint.js'

const limits = (overrides = {}) => ({ maxFileBytes: 1024 * 1024, maxFiles: 1000, excludeDirs: ['node_modules'], gitignore: true, excludePaths: [], ...overrides })

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dmr-checkpoint-'))
  const work = join(base, 'work')
  const store = new CheckpointStore(join(base, 'store'))
  await mkdir(join(work, 'src', 'nested'), { recursive: true })
  await mkdir(join(work, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(work, '.git'), { recursive: true })
  await writeFile(join(work, 'src', 'a.txt'), 'alpha\n')
  await writeFile(join(work, 'src', 'nested', 'b.txt'), 'beta\n')
  await writeFile(join(work, 'run.sh'), '#!/bin/sh\necho hi\n')
  await chmod(join(work, 'run.sh'), 0o755)
  await writeFile(join(work, '.gitignore'), 'build/\n*.log\n!keep.log\n')
  await writeFile(join(work, 'node_modules', 'dep', 'index.js'), 'dep v1')
  await writeFile(join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(work, 'debug.log'), 'ignored log v1')
  await writeFile(join(work, 'keep.log'), 'kept log v1')
  await symlink('src/a.txt', join(work, 'link-to-a'))
  return { base, work, store }
}

async function exists(path) { try { await lstat(path); return true } catch { return false } }

test('walk honors .gitignore, negation, fixed excludes, and .git', async () => {
  const { base, work } = await fixture()
  try {
    const walked = await walk(work, limits())
    assert.deepEqual([...walked.entries.keys()].sort(), ['.gitignore', 'keep.log', 'link-to-a', 'run.sh', 'src/a.txt', 'src/nested/b.txt'])
    assert.deepEqual(walked.dirs.sort(), ['src', 'src/nested'])
    assert.equal(walked.truncated, false)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('restore puts edited, deleted, added files and links back; ignored paths stay untouched', async () => {
  const { base, work, store } = await fixture()
  try {
    const manifest = await store.snapshot(work, limits())
    assert.equal(Object.keys(manifest.entries).length, 6)

    // The agent edits, deletes, creates, retargets, and touches ignored paths.
    await writeFile(join(work, 'src', 'a.txt'), 'alpha EDITED\n')
    await rm(join(work, 'src', 'nested', 'b.txt'))
    await mkdir(join(work, 'src', 'new-dir', 'deep'), { recursive: true })
    await writeFile(join(work, 'src', 'new-dir', 'deep', 'c.txt'), 'gamma')
    await writeFile(join(work, 'added.txt'), 'added')
    await rm(join(work, 'link-to-a'))
    await symlink('run.sh', join(work, 'link-to-a'))
    await chmod(join(work, 'run.sh'), 0o644)
    await writeFile(join(work, 'node_modules', 'dep', 'index.js'), 'dep v2')
    await writeFile(join(work, 'debug.log'), 'ignored log v2')
    await mkdir(join(work, 'build'))
    await writeFile(join(work, 'build', 'out.bin'), 'artifact')

    const result = await store.restore(manifest, limits())
    assert.deepEqual(result.failed, [])
    assert.equal(await readFile(join(work, 'src', 'a.txt'), 'utf8'), 'alpha\n')
    assert.equal(await readFile(join(work, 'src', 'nested', 'b.txt'), 'utf8'), 'beta\n')
    assert.equal(await exists(join(work, 'added.txt')), false)
    assert.equal(await exists(join(work, 'src', 'new-dir')), false, 'directories created after the checkpoint are removed')
    assert.equal(await readlink(join(work, 'link-to-a')), 'src/a.txt')
    assert.equal((await stat(join(work, 'run.sh'))).mode & 0o777, 0o755)
    // Ignored and excluded content is never touched.
    assert.equal(await readFile(join(work, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep v2')
    assert.equal(await readFile(join(work, 'debug.log'), 'utf8'), 'ignored log v2')
    assert.equal(await readFile(join(work, 'build', 'out.bin'), 'utf8'), 'artifact')
    assert.equal(await readFile(join(work, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n')
    assert.ok(result.written >= 3 && result.deleted >= 2)

    // A second restore of the same state changes nothing.
    const again = await store.restore(manifest, limits())
    assert.equal(again.written, 0)
    assert.equal(again.deleted, 0)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('blobs are deduplicated and unchanged files are not rehashed', async () => {
  const { base, work, store } = await fixture()
  try {
    await writeFile(join(work, 'copy.txt'), 'alpha\n')
    const first = await store.snapshot(work, limits())
    assert.equal(first.entries['copy.txt'].hash, first.entries['src/a.txt'].hash)
    const buckets = await readdir(join(base, 'store', 'objects'))
    let blobs = 0
    for (const bucket of buckets) blobs += (await readdir(join(base, 'store', 'objects', bucket))).length
    assert.equal(blobs, 5, 'six files with one duplicate store five blobs')
    const second = await store.snapshot(work, limits())
    assert.deepEqual(second.entries, first.entries)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('oversized files are skipped and left alone; a truncated checkpoint deletes nothing', async () => {
  const { base, work, store } = await fixture()
  try {
    await writeFile(join(work, 'big.bin'), Buffer.alloc(4096, 1))
    const manifest = await store.snapshot(work, limits({ maxFileBytes: 1024 }))
    assert.deepEqual(manifest.skipped, ['big.bin'])
    await writeFile(join(work, 'big.bin'), Buffer.alloc(8192, 2))
    await store.restore(manifest, limits({ maxFileBytes: 1024 }))
    assert.equal((await stat(join(work, 'big.bin'))).size, 8192)

    const truncated = await store.snapshot(work, limits({ maxFiles: 2 }))
    assert.equal(truncated.truncated, true)
    await writeFile(join(work, 'fresh.txt'), 'new')
    await writeFile(join(work, '.gitignore'), 'changed')
    const result = await store.restore(truncated, limits({ maxFiles: 2 }))
    assert.equal(result.deleted, 0)
    assert.equal(await exists(join(work, 'fresh.txt')), true)
    assert.equal(await readFile(join(work, '.gitignore'), 'utf8'), 'build/\n*.log\n!keep.log\n')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('excludePaths keeps the storage directory out of a checkpoint of its parent', async () => {
  const { base, store } = await fixture()
  try {
    await store.snapshot(join(base, 'work'), limits())
    const manifest = await store.snapshot(base, limits({ excludePaths: [join(base, 'store')] }))
    assert.ok(Object.keys(manifest.entries).every(path => !path.startsWith('store/')))
    assert.ok('work/src/a.txt' in manifest.entries)
  } finally { await rm(base, { recursive: true, force: true }) }
})
