#!/usr/bin/env node
/**
 * One-command DeepSeek Harness version bump for this plugin.
 *
 *   npm run sync-dsh -- 0.2.2-rc.1
 *
 * It updates, in one pass:
 *   - package.json version (derived from the DSH version, e.g. 0.2.2-rc.1 -> 0.2.2)
 *   - the four @deepseek-ai/dsh-* peerDependencies
 *   - @deepseek-ai/cordis peer range (copied from dsh-llm's own peer range)
 *   - @earendil-works/pi-ai dependency range (copied from dsh-llm-pi-ai)
 *   - README badge / prerequisites / compatibility version strings
 *   - `DSH \`<version>\`` references in source and test comments
 *   - package-lock.json, node_modules, lib/ (clean install + rebuild + tests)
 *
 * Options:
 *   --cordis <range|version>    override the cordis peer range (bare version -> ~x.y.z)
 *   --pi-ai <range>             override the @earendil-works/pi-ai dependency range
 *   --plugin-version <version>  override the derived plugin version
 *   --no-install                skip the clean npm install
 *   --no-build                  skip `npm run build`
 *   --no-test                   skip the test suites
 *   --dry-run                   print the planned changes, write nothing
 *   -h, --help                  show this help
 *
 * Notes:
 *   - `npm test` cannot be used on this machine (node:test child spawn -> EPERM),
 *     so the test step runs every tests/*.test.mts in-process plus smoke.mjs.
 *   - Upstream releases occasionally remove client packages (DSH 0.2.2 removed
 *     @deepseek-ai/dsh-client-runtime). Those are structural changes; if
 *     `npm run sync-dsh` reports one, update `dsh.client.inject` /
 *     `dsh.client.external` / tsdown.config.ts CLIENT_EXTERNALS by hand.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DSH_PEER_PACKAGES = [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
]
export const CORDIS_PACKAGE = '@deepseek-ai/cordis'
export const PI_AI_PACKAGE = '@earendil-works/pi-ai'

const DSH_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

/** `0.2.2-rc.1` -> `0.2.2`; throws on anything that is not a DSH version. */
export function derivePluginVersion(dshVersion) {
  if (!DSH_VERSION_RE.test(dshVersion)) {
    throw new Error(`not a DSH version: "${dshVersion}" (expected e.g. 0.2.2-rc.1)`)
  }
  return dshVersion.split('-')[0]
}

/** `0.2.2-rc.1` -> `0.2.2--rc.1` (shields.io badge encoding). */
export function badgeVersion(dshVersion) {
  return dshVersion.replace(/-/g, '--')
}

/** Rewrite the version strings that the README keeps in sync. */
export function rewriteReadme(text, dshVersion) {
  const base = derivePluginVersion(dshVersion)
  let out = text
  // shields.io badge: keep the trailing colour suffix (`-blueviolet`).
  out = out.replace(
    /DeepSeek%20Harness-\d+\.\d+\.\d+(?:--[0-9A-Za-z.]+)?/,
    `DeepSeek%20Harness-${badgeVersion(dshVersion)}`,
  )
  // Prerequisites bullet: "- **DeepSeek Harness** `x` ..."
  out = out.replace(
    /- \*\*DeepSeek Harness\*\* `[^`]+`/,
    `- **DeepSeek Harness** \`${dshVersion}\``,
  )
  // Harness compatibility: "This plugin targets **DeepSeek Harness `x`**."
  out = out.replace(
    /targets \*\*DeepSeek Harness `[^`]+`\*\*/,
    `targets **DeepSeek Harness \`${dshVersion}\`**`,
  )
  // "... matching the DSH\n  `x.y.z` release convention ..." uses the base version.
  out = out.replace(
    /matching the DSH\s*\n?\s*`[^`]+` release convention/,
    `matching the DSH\n  \`${base}\` release convention`,
  )
  return out
}

/** Rewrite `DSH `<version>`` references in source/test doc comments. */
export function rewriteDocVersions(text, dshVersion) {
  return text.replace(/\bDSH `[^`\n]+`/g, `DSH \`${dshVersion}\``)
}

// ---------------------------------------------------------------------------
// CLI plumbing (kept below the pure helpers so they can be unit-tested)
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const args = {
    positional: [],
    install: true,
    build: true,
    test: true,
    dryRun: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-install') args.install = false
    else if (arg === '--no-build') args.build = false
    else if (arg === '--no-test') args.test = false
    else if (arg === '--cordis') args.cordis = argv[(i += 1)]
    else if (arg === '--pi-ai') args.piAi = argv[(i += 1)]
    else if (arg === '--plugin-version') args.pluginVersion = argv[(i += 1)]
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('-')) fail(`unknown option: ${arg}`)
    else args.positional.push(arg)
  }
  return args
}

function printHelp() {
  console.log(`Usage: npm run sync-dsh -- <dsh-version> [options]

  <dsh-version>                e.g. 0.2.2-rc.1

Options:
  --cordis <range|version>     override the cordis peer range
  --pi-ai <range>              override the @earendil-works/pi-ai range
  --plugin-version <version>   override the plugin version (default: DSH base)
  --no-install                 skip the clean npm install
  --no-build                   skip npm run build
  --no-test                    skip the test suites
  --dry-run                    show planned changes without writing
  -h, --help                   show this help`)
}

function normalizeCordis(value) {
  if (!value) return value
  return /^\d+\.\d+\.\d+$/.test(value) ? `~${value}` : value
}

async function fetchRegistryMeta(pkg, version) {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/${encodeURIComponent(version)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) {
    fail(`cannot resolve ${pkg}@${version} on the npm registry (HTTP ${response.status})`)
  }
  return response.json()
}

function collectDocFiles() {
  const files = []
  const skip = new Set(['node_modules', 'lib', '.git', '.acl-recovery', 'dist', 'scripts'])
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full)
      } else if (/\.(ts|tsx|mts|mjs|yml)$/.test(entry.name)) {
        files.push(full)
      }
    }
  }
  for (const dir of ['src', 'tests', 'bin']) {
    const full = path.join(ROOT, dir)
    if (fs.existsSync(full)) walk(full)
  }
  const patch = path.join(ROOT, 'cordis.patch.yml')
  if (fs.existsSync(patch)) files.push(patch)
  return files
}

function checkResult(result, label) {
  if (result.error) fail(`failed to run ${label}: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${label} exited with ${result.status ?? 'an unknown status'}`)
  }
}

/** Run an executable directly (no shell); used for node itself. */
function runFile(exe, args) {
  checkResult(
    spawnSync(exe, args, { cwd: ROOT, stdio: 'inherit', env: process.env }),
    `${exe} ${args.join(' ')}`,
  )
}

/** Run through the shell; used for `npm`, which is npm.cmd on Windows. */
function runShell(commandLine) {
  checkResult(
    spawnSync(commandLine, { cwd: ROOT, stdio: 'inherit', env: process.env, shell: true }),
    commandLine,
  )
}

function quoteForCmd(token) {
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token
}

function npm(args) {
  if (process.platform === 'win32') {
    runShell([npmCommand(), ...args.map(quoteForCmd)].join(' '))
  } else {
    runFile(npmCommand(), args)
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function runTests() {
  const testsDir = path.join(ROOT, 'tests')
  const suites = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mts'))
    .sort()
  for (const suite of suites) {
    console.log(`\n▶ tests/${suite}`)
    runFile(process.execPath, ['--experimental-strip-types', path.join('tests', suite)])
  }
  const smoke = path.join(testsDir, 'smoke.mjs')
  if (fs.existsSync(smoke)) {
    console.log('\n▶ tests/smoke.mjs')
    runFile(process.execPath, [path.join('tests', 'smoke.mjs')])
  }
}

function writeIfChanged(file, next) {
  const previous = fs.readFileSync(file, 'utf8')
  if (previous === next) return false
  fs.writeFileSync(file, next)
  return true
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.positional.length !== 1) {
    printHelp()
    process.exitCode = 2
    return
  }

  const dshVersion = args.positional[0]
  const pluginVersion = args.pluginVersion ?? derivePluginVersion(dshVersion)
  if (!DSH_VERSION_RE.test(dshVersion)) fail(`not a DSH version: "${dshVersion}"`)

  const pkgPath = path.join(ROOT, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

  console.log(`\nResolving DeepSeek Harness ${dshVersion} on the npm registry...`)
  const dshLlm = await fetchRegistryMeta('@deepseek-ai/dsh-llm', dshVersion)
  const piAiPackage = await fetchRegistryMeta('@deepseek-ai/dsh-llm-pi-ai', dshVersion)
  await fetchRegistryMeta('@deepseek-ai/dsh-host-webserver', dshVersion)
  await fetchRegistryMeta('@deepseek-ai/dsh-launch-environment', dshVersion)

  const cordisRange =
    normalizeCordis(args.cordis) ??
    dshLlm.peerDependencies?.[CORDIS_PACKAGE] ??
    fail('dsh-llm does not declare a @deepseek-ai/cordis peer range; pass --cordis')
  const piAiRange =
    args.piAi ??
    piAiPackage.dependencies?.[PI_AI_PACKAGE] ??
    piAiPackage.peerDependencies?.[PI_AI_PACKAGE] ??
    fail('dsh-llm-pi-ai does not declare @earendil-works/pi-ai; pass --pi-ai')

  const changes = []
  const note = (label, before, after) => {
    if (before !== after) changes.push(`  ${label}: ${before ?? '(missing)'} -> ${after}`)
  }

  note('version', pkg.version, pluginVersion)
  pkg.version = pluginVersion
  for (const name of DSH_PEER_PACKAGES) {
    note(`peer ${name}`, pkg.peerDependencies?.[name], dshVersion)
    pkg.peerDependencies[name] = dshVersion
  }
  note(`peer ${CORDIS_PACKAGE}`, pkg.peerDependencies?.[CORDIS_PACKAGE], cordisRange)
  pkg.peerDependencies[CORDIS_PACKAGE] = cordisRange
  note(`dependency ${PI_AI_PACKAGE}`, pkg.dependencies?.[PI_AI_PACKAGE], piAiRange)
  pkg.dependencies[PI_AI_PACKAGE] = piAiRange

  const fileWrites = []
  const addWrite = (file, next) => {
    const previous = fs.readFileSync(file, 'utf8')
    if (previous !== next) {
      fileWrites.push(file)
      if (!args.dryRun) fs.writeFileSync(file, next)
    }
  }

  addWrite(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  const readmePath = path.join(ROOT, 'README.md')
  addWrite(readmePath, rewriteReadme(fs.readFileSync(readmePath, 'utf8'), dshVersion))

  for (const file of collectDocFiles()) {
    const previous = fs.readFileSync(file, 'utf8')
    addWrite(file, rewriteDocVersions(previous, dshVersion))
  }

  console.log(`\nDeepSeek Harness ${dshVersion} compatibility plan`)
  if (changes.length === 0 && fileWrites.length === 0) {
    console.log('  (already in sync — nothing to change)')
  } else {
    for (const line of changes) console.log(line)
    for (const file of fileWrites) console.log(`  updated ${path.relative(ROOT, file)}`)
  }

  if (args.dryRun) {
    console.log('\nDry run: no files written, no install/build/test performed.')
    return
  }

  if (args.install) {
    console.log('\nRemoving node_modules and package-lock.json, then reinstalling...')
    fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(ROOT, 'package-lock.json'), { force: true })
    npm(['install', '--no-audit', '--no-fund'])
  }

  if (args.build) {
    console.log('\nBuilding lib/...')
    npm(['run', 'build'])
  }

  if (args.test) {
    console.log('\nRunning test suites in-process (npm test is unusable here)...')
    runTests()
  }

  console.log(`
Done: plugin ${pkg.version} now targets DeepSeek Harness ${dshVersion}.

Next:
  git add -A
  git commit -m "chore: support DeepSeek Harness ${dshVersion}"
  git push origin main

Then fully quit and restart DSH so the new lib/ bundle is loaded.`)
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n✖ ${error.message}`)
    process.exitCode = 1
  })
}
