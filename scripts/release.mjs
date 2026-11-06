// Prepare a prebuilt GitHub release commit for the version in package.json.
//
// The source branch never carries lib/; it is built at install time only when
// a `prepare` script exists, which makes pnpm install every devDependency
// first. A release commit instead holds the built lib/ and drops `prepare`,
// so `github:<owner>/<repo>#<sha>` installs like a registry tarball: no
// devDependencies, no build, no build approval.
//
// The commit is made with plumbing (a temporary index), so the working tree
// and the current branch are left untouched. It lands on `release` (parents:
// the previous release and the source commit) and is tagged `v<version>`.
// Nothing is pushed.
//
//   node scripts/release.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const RELEASE_BRANCH = 'refs/heads/release'
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...options }).trim()
const git = (args, options) => run('git', args, options)
const tryGit = (args) => { try { return git(args, { stdio: ['pipe', 'pipe', 'ignore'] }) } catch { return null } }
const fail = (message) => { console.error(`release: ${message}`); process.exit(1) }

if (git(['status', '--porcelain']) !== '') fail('working tree is not clean; commit the source first')
const source = git(['rev-parse', 'HEAD'])
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${manifest.version}`
if (tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) !== null) fail(`tag ${tag} already exists; bump the version`)
const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(repository ?? '')?.[1] ?? /^github:([^/]+\/[^#]+)$/.exec(repository ?? '')?.[1]
if (repo === undefined) fail('package.json needs a GitHub repository field')

rmSync(join(root, 'lib'), { recursive: true, force: true })
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
execFileSync('npm', ['test'], { cwd: root, stdio: 'inherit' })
for (const file of [manifest.main, ...Object.values(manifest.exports ?? {})]) {
  if (typeof file === 'string' && file.startsWith('./lib/') && !existsSync(join(root, file))) fail(`missing build output ${file}`)
}
if (git(['status', '--porcelain']) !== '') fail('build or tests changed tracked files')

const released = structuredClone(manifest)
for (const script of ['prepare', 'prepack', 'prepublish', 'prepublishOnly']) delete released.scripts?.[script]

// The source commit's author signs the release when git has no identity.
const env = { ...process.env, GIT_INDEX_FILE: join(git(['rev-parse', '--absolute-git-dir']), 'release-index') }
if (tryGit(['config', 'user.email']) === null) {
  const [name, email] = git(['log', '-1', '--format=%an%n%ae', source]).split('\n')
  Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email })
}
const withIndex = (args, input) => git(args, { env, ...(input === undefined ? {} : { input }) })
try {
  withIndex(['read-tree', source])
  withIndex(['add', '--force', '--', 'lib'])
  const blob = withIndex(['hash-object', '-w', '--stdin'], `${JSON.stringify(released, null, 2)}\n`)
  withIndex(['update-index', '--cacheinfo', `100644,${blob},package.json`])
  const tree = withIndex(['write-tree'])
  const previous = tryGit(['rev-parse', '--verify', '--quiet', RELEASE_BRANCH])
  const parents = [...(previous === null ? [] : ['-p', previous]), '-p', source]
  const commit = withIndex(['commit-tree', tree, ...parents, '-m', `release: ${tag}\n\nPrebuilt from ${source}.`])
  git(['update-ref', RELEASE_BRANCH, commit, ...(previous === null ? [] : [previous])], { env })
  git(['tag', tag, commit], { env })
  console.log(`\nrelease ${tag}\n  source  ${source}\n  release ${commit}\n  install github:${repo}#${commit}`)
} finally {
  rmSync(env.GIT_INDEX_FILE, { force: true })
}
