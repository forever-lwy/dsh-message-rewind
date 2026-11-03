/**
 * Workspace checkpoints: a content-addressed copy of every tracked file under
 * a Session working directory, taken before the agent acts on a user message,
 * and the restore that puts the directory back into exactly that state.
 *
 * Tracked files are the regular files and symlinks below the working
 * directory that `.gitignore` rules (at any depth) and the configured
 * directory names do not exclude. Ignored paths are neither copied nor
 * touched on restore, so dependency folders and build caches survive a
 * rewind. A walk that exceeds the file limit is marked `truncated`; restoring
 * a truncated checkpoint rewrites the copied files but deletes nothing.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib'
import ignore, { type Ignore } from 'ignore'

const gzip = promisify(gzipCallback)
const gunzip = promisify(gunzipCallback)

/** Walk and copy bounds. */
export interface CheckpointLimits {
  /** Files larger than this are listed as skipped and left untouched on restore. */
  maxFileBytes: number
  /** A walk stops after this many tracked entries and marks the checkpoint truncated. */
  maxFiles: number
  /** Directory names excluded at any depth, in addition to `.git`. */
  excludeDirs: readonly string[]
  /** Whether `.gitignore` files are honored. */
  gitignore: boolean
  /** Absolute paths never walked (this plugin's own storage, the DSH home). */
  excludePaths: readonly string[]
}

/** One tracked entry. */
export type CheckpointEntry =
  | { kind: 'file'; hash: string; size: number; mode: number }
  | { kind: 'link'; target: string }

/** Persisted checkpoint manifest. */
export interface CheckpointManifest {
  version: 1
  cwd: string
  createdAt: number
  /** Tracked entries keyed by slash-separated path relative to `cwd`. */
  entries: Record<string, CheckpointEntry>
  /** Tracked directories, relative and slash-separated. */
  dirs: string[]
  /** Files over the size limit or unreadable; restore leaves them as they are. */
  skipped: string[]
  /** The walk stopped at the file limit; restore deletes nothing. */
  truncated: boolean
}

/** Outcome of one restore. */
export interface RestoreResult {
  written: number
  deleted: number
  unchanged: number
  /** Paths the restore could not write or delete. */
  failed: string[]
}

interface WalkedFile {
  kind: 'file'
  size: number
  mtimeMs: number
  ino: number
  mode: number
}
interface WalkedLink {
  kind: 'link'
  target: string
}
interface Walked {
  entries: Map<string, WalkedFile | WalkedLink>
  dirs: string[]
  skipped: string[]
  truncated: boolean
}

/** Stat facts that let a later snapshot reuse a file's hash without reading it. */
interface StatRow { size: number; mtimeMs: number; ino: number; hash: string }

interface Matcher {
  /** Directory of the `.gitignore`, relative to the walk root ('' for the root). */
  base: string
  rules: Ignore
}

function ignoredBy(matchers: readonly Matcher[], rel: string, directory: boolean): boolean {
  let ignored = false
  for (const matcher of matchers) {
    const local = matcher.base === '' ? rel : rel.slice(matcher.base.length + 1)
    const result = matcher.rules.test(directory ? `${local}/` : local)
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

/** Run `work` over `items` with at most `limit` in flight, keeping result order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const IO_CONCURRENCY = 32

/**
 * List the tracked entries below `root` without reading file contents.
 * @param root - absolute working directory.
 * @param limits - walk bounds.
 * @param signal - aborts the walk.
 * @returns tracked entries, directories, oversized files, and truncation.
 */
export async function walk(root: string, limits: CheckpointLimits, signal?: AbortSignal): Promise<Walked> {
  const excluded = new Set(['.git', ...limits.excludeDirs])
  const excludedPaths = limits.excludePaths.map(path => resolve(path))
  const entries = new Map<string, WalkedFile | WalkedLink>()
  const dirs: string[] = []
  const skipped: string[] = []
  let truncated = false

  async function visit(absolute: string, rel: string, matchers: readonly Matcher[]): Promise<void> {
    if (truncated) return
    signal?.throwIfAborted()
    let names: string[]
    try { names = (await readdir(absolute)).sort() } catch { return }
    let scoped = matchers
    if (limits.gitignore && names.includes('.gitignore')) {
      try {
        const rules = ignore().add(await readFile(join(absolute, '.gitignore'), 'utf8'))
        scoped = [...matchers, { base: rel, rules }]
      } catch { /* An unreadable ignore file adds no rules. */ }
    }
    const infos = await mapLimited(names, IO_CONCURRENCY, name => lstat(join(absolute, name)).catch(() => undefined))
    for (const [index, name] of names.entries()) {
      if (truncated) return
      const info = infos[index]
      if (info === undefined) continue
      const childAbsolute = join(absolute, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (info.isDirectory()) {
        if (excluded.has(name) || excludedPaths.some(path => childAbsolute === path || childAbsolute.startsWith(path + sep))) continue
        if (ignoredBy(scoped, childRel, true)) continue
        dirs.push(childRel)
        await visit(childAbsolute, childRel, scoped)
        continue
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue
      if (ignoredBy(scoped, childRel, false)) continue
      if (entries.size >= limits.maxFiles) { truncated = true; return }
      if (info.isSymbolicLink()) {
        try { entries.set(childRel, { kind: 'link', target: await readlink(childAbsolute) }) } catch { skipped.push(childRel) }
        continue
      }
      if (info.size > limits.maxFileBytes) { skipped.push(childRel); continue }
      entries.set(childRel, { kind: 'file', size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, mode: info.mode & 0o7777 })
    }
  }

  await visit(resolve(root), '', [])
  return { entries, dirs, skipped, truncated }
}

/**
 * Content-addressed checkpoint storage: gzip-compressed blobs named by the
 * SHA-256 of their raw bytes, plus JSON manifests. A per-root stat cache
 * (size, mtime, inode) avoids rehashing unchanged files on later snapshots.
 */
export class CheckpointStore {
  private readonly statCache = new Map<string, Map<string, StatRow>>()

  constructor(readonly directory: string) {}

  private objectPath(hash: string): string {
    return join(this.directory, 'objects', hash.slice(0, 2), hash)
  }

  /**
   * Store a JSON document as a content-addressed blob.
   * @param value - JSON-serializable value.
   * @returns the blob hash.
   */
  async putJson(value: unknown): Promise<string> {
    const data = Buffer.from(JSON.stringify(value))
    const hash = createHash('sha256').update(data).digest('hex')
    await this.putObject(hash, data)
    return hash
  }

  /**
   * Read a JSON blob written by {@link putJson}.
   * @param hash - blob hash.
   * @returns the parsed value.
   */
  async readJson<T>(hash: string): Promise<T> {
    return JSON.parse((await this.readObject(hash)).toString('utf8')) as T
  }

  private async putObject(hash: string, data: Buffer): Promise<void> {
    const path = this.objectPath(hash)
    try { await stat(path); return } catch { /* Missing: write it. */ }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, await gzip(data, { level: 1 }))
    await rename(temporary, path)
  }

  /**
   * Read one stored blob.
   * @param hash - SHA-256 hex digest.
   * @returns the raw bytes.
   */
  async readObject(hash: string): Promise<Buffer> {
    return gunzip(await readFile(this.objectPath(hash)))
  }

  private cachePath(root: string): string {
    return join(this.directory, 'cache', `${createHash('sha256').update(root).digest('hex')}.json`)
  }

  /** The stat cache of one root, loaded from disk after a restart. */
  private async cacheOf(root: string): Promise<Map<string, StatRow>> {
    const loaded = this.statCache.get(root)
    if (loaded) return loaded
    let rows = new Map<string, StatRow>()
    try {
      const value = JSON.parse(await readFile(this.cachePath(root), 'utf8')) as { root?: string; rows?: [string, StatRow][] }
      if (value.root === root && Array.isArray(value.rows)) rows = new Map(value.rows)
    } catch { /* No cache yet. */ }
    this.statCache.set(root, rows)
    return rows
  }

  /**
   * Copy every tracked file under `root` into the store.
   * @param root - absolute working directory.
   * @param limits - walk and size bounds.
   * @param signal - aborts the snapshot; nothing partial is returned.
   * @returns the manifest describing the directory at this moment.
   */
  async snapshot(root: string, limits: CheckpointLimits, signal?: AbortSignal): Promise<CheckpointManifest> {
    const absoluteRoot = resolve(root)
    const walked = await walk(absoluteRoot, limits, signal)
    const previous = await this.cacheOf(absoluteRoot)
    const next = new Map<string, StatRow>()
    const entries: Record<string, CheckpointEntry> = {}
    const skipped = [...walked.skipped]
    const rows = [...walked.entries]
    const hashes = await mapLimited(rows, IO_CONCURRENCY / 2, async ([rel, item]) => {
      if (item.kind === 'link') return undefined
      signal?.throwIfAborted()
      const cached = previous.get(rel)
      if (cached && cached.size === item.size && cached.mtimeMs === item.mtimeMs && cached.ino === item.ino) return cached.hash
      let data: Buffer
      try { data = await readFile(join(absoluteRoot, rel)) } catch { return null }
      const hash = createHash('sha256').update(data).digest('hex')
      await this.putObject(hash, data)
      return hash
    })
    for (const [index, [rel, item]] of rows.entries()) {
      if (item.kind === 'link') { entries[rel] = { kind: 'link', target: item.target }; continue }
      const hash = hashes[index]
      if (typeof hash !== 'string') { skipped.push(rel); continue }
      next.set(rel, { size: item.size, mtimeMs: item.mtimeMs, ino: item.ino, hash })
      entries[rel] = { kind: 'file', hash, size: item.size, mode: item.mode }
    }
    this.statCache.set(absoluteRoot, next)
    await this.writeJson(this.cachePath(absoluteRoot), { root: absoluteRoot, rows: [...next] }).catch(() => {})
    return { version: 1, cwd: absoluteRoot, createdAt: Date.now(), entries, dirs: walked.dirs, skipped, truncated: walked.truncated }
  }

  /**
   * Put `manifest.cwd` back into the recorded state. Tracked files that did
   * not exist then are deleted (unless either walk was truncated), changed
   * files are rewritten atomically, and directories created since are removed
   * when empty. Ignored and skipped paths are never touched.
   * @param manifest - checkpoint to restore.
   * @param limits - the same walk bounds used for snapshots.
   * @returns counts of written, deleted, and unchanged entries.
   */
  async restore(manifest: CheckpointManifest, limits: CheckpointLimits): Promise<RestoreResult> {
    const root = manifest.cwd
    const current = await walk(root, limits)
    const keepSkipped = new Set(manifest.skipped)
    const result: RestoreResult = { written: 0, deleted: 0, unchanged: 0, failed: [] }
    const cache = await this.cacheOf(root)
    const absolute = (rel: string) => join(root, ...rel.split('/'))

    if (!manifest.truncated && !current.truncated) {
      for (const rel of current.entries.keys()) {
        if (rel in manifest.entries || keepSkipped.has(rel)) continue
        try { await unlink(absolute(rel)); result.deleted++ } catch { result.failed.push(rel) }
      }
    }

    for (const [rel, entry] of Object.entries(manifest.entries)) {
      const target = absolute(rel)
      const now = current.entries.get(rel)
      if (entry.kind === 'link') {
        if (now?.kind === 'link' && now.target === entry.target) { result.unchanged++; continue }
        try {
          await clearPath(target)
          await mkdir(dirname(target), { recursive: true })
          await symlink(entry.target, target)
          result.written++
        } catch { result.failed.push(rel) }
        continue
      }
      if (now?.kind === 'file' && now.size === entry.size) {
        const cached = cache?.get(rel)
        if (cached && cached.size === now.size && cached.mtimeMs === now.mtimeMs && cached.ino === now.ino && cached.hash === entry.hash) {
          if (now.mode !== entry.mode) await chmod(target, entry.mode).catch(() => {})
          result.unchanged++
          continue
        }
        try {
          const data = await readFile(target)
          if (createHash('sha256').update(data).digest('hex') === entry.hash) {
            if (now.mode !== entry.mode) await chmod(target, entry.mode).catch(() => {})
            result.unchanged++
            continue
          }
        } catch { /* Rewrite below. */ }
      }
      try {
        const data = await this.readObject(entry.hash)
        if (now === undefined || now.kind === 'link') await clearPath(target)
        await mkdir(dirname(target), { recursive: true })
        const temporary = join(dirname(target), `.${randomUUID()}.dmr-tmp`)
        await writeFile(temporary, data, { mode: entry.mode })
        await chmod(temporary, entry.mode).catch(() => {})
        await rename(temporary, target)
        result.written++
      } catch { result.failed.push(rel) }
    }

    if (!manifest.truncated && !current.truncated) {
      const keep = new Set(manifest.dirs)
      const extra = current.dirs.filter(dir => !keep.has(dir)).sort((a, b) => b.length - a.length)
      for (const dir of extra) await rmdir(absolute(dir)).catch(() => {})
    }
    // The working tree changed under the cache; the next snapshot rehashes.
    this.statCache.set(root, new Map())
    await rm(this.cachePath(root), { force: true })
    return result
  }

  /**
   * Write one JSON document atomically.
   * @param path - absolute target path.
   * @param value - JSON-serializable value.
   */
  async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, path)
  }

  /**
   * Delete blobs no manifest references.
   * @param referenced - every hash still listed by a kept manifest.
   * @returns the number of removed blobs.
   */
  async sweep(referenced: ReadonlySet<string>): Promise<number> {
    const objects = join(this.directory, 'objects')
    let removed = 0
    let buckets: string[]
    try { buckets = await readdir(objects) } catch { return 0 }
    for (const bucket of buckets) {
      let names: string[]
      try { names = await readdir(join(objects, bucket)) } catch { continue }
      for (const name of names) {
        if (referenced.has(name)) continue
        await rm(join(objects, bucket, name), { force: true })
        removed++
      }
      await rmdir(join(objects, bucket)).catch(() => {})
    }
    return removed
  }
}

/** Remove whatever occupies `path` (file, link, or directory) so a file or link can take its place. */
async function clearPath(path: string): Promise<void> {
  let info
  try { info = await lstat(path) } catch { return }
  if (info.isDirectory()) await rm(path, { recursive: true, force: true })
  else await unlink(path)
}

/** Paths are relative and slash-separated; reject anything that would leave the root. */
export function isSafeRelative(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false
  return !rel.split('/').some(part => part === '..' || part === '.' || part === '')
}

/** Drop manifest entries whose paths are unsafe (defense against a corrupted manifest). */
export function sanitizeManifest(manifest: CheckpointManifest): CheckpointManifest {
  const entries: Record<string, CheckpointEntry> = {}
  for (const [rel, entry] of Object.entries(manifest.entries ?? {})) {
    if (!isSafeRelative(rel)) continue
    if (entry.kind === 'file' && !/^[0-9a-f]{64}$/.test(entry.hash)) continue
    entries[rel] = entry
  }
  return {
    ...manifest,
    entries,
    dirs: (manifest.dirs ?? []).filter(isSafeRelative),
    skipped: (manifest.skipped ?? []).filter(isSafeRelative),
  }
}
