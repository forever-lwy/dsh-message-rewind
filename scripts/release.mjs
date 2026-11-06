// Prepare the prebuilt commit for a release tag.
//
// Releases are cut by tagging a source commit `v<version>` (matching
// package.json). The source never carries lib/; installing it from GitHub
// would run `prepare`, which makes pnpm install every devDependency and build.
// This script builds and tests the tagged commit, then records a prebuilt
// commit — the same tree plus lib/, with `prepare` removed — whose only parent
// is the source commit, and tags it `dist/v<version>`. No branch is created
// or moved; the commit is reachable through that tag alone. Installing
// `github:<owner>/<repo>#dist/v<version>` needs no devDependencies or build.
//
// The commit is made with plumbing (a temporary index), so the working tree
// and the current branch are left untouched. Nothing is pushed;
// .github/workflows/release.yml runs this for each pushed v* tag and pushes
// the dist tag.
//
//   git tag v<version> && node scripts/release.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...options }).trim()
const git = (args, options) => run('git', args, options)
const tryGit = (args) => { try { return git(args, { stdio: ['pipe', 'pipe', 'ignore'] }) } catch { return null } }
const fail = (message) => { console.error(`release: ${message}`); process.exit(1) }

if (git(['status', '--porcelain']) !== '') fail('working tree is not clean; commit the source first')
const source = git(['rev-parse', 'HEAD'])
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${manifest.version}`
const distTag = `dist/${tag}`
const tagged = tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])
if (tagged === null) fail(`tag ${tag} does not exist; tag the source commit first`)
if (tagged !== source) fail(`tag ${tag} points at ${tagged}, not HEAD ${source}; check out the tag (package.json says ${manifest.version})`)
if (tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${distTag}`]) !== null) fail(`${distTag} already exists`)
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
  const commit = withIndex(['commit-tree', tree, '-p', source, '-m', `dist: ${tag}\n\nPrebuilt from ${source}.`])
  git(['tag', distTag, commit], { env })
  const install = `github:${repo}#${distTag}`
  console.log(`\nrelease ${tag}\n  source  ${source}\n  dist    ${commit} (${distTag})\n  install ${install}`)
  // In GitHub Actions: expose the result and show the install source on the run page.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\ndist-tag=${distTag}\ninstall=${install}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## ${manifest.name} ${tag}\n\n- source: \`${source}\`\n- dist: \`${commit}\` (\`${distTag}\`)\n\nInstall:\n\n\`\`\`text\n${install}\n\`\`\`\n`)
  }
} finally {
  rmSync(env.GIT_INDEX_FILE, { force: true })
}
