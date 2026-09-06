#!/usr/bin/env node
// Login script for dsh-llm-minimax-oauth
// Wraps the plugin's runAuthorization with explicit stdout flushing so output
// is visible whether running interactively or via subprocess.
//
// Supports the MiniMax Global Coding Plan only.
import path from 'node:path'
import url from 'node:url'
import readline from 'node:readline/promises'
import fs from 'node:fs'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const plugin = await import(url.pathToFileURL(path.join(pkgRoot, 'lib/index.mjs')).href)
const { DEFAULT_PROVIDER_PROFILES, FileCredentialStore, runAuthorization } = plugin

function out(...args) {
  process.stdout.write(args.join(' ') + '\n')
}

function parseArgs(argv) {
  const opts = { provider: null, noBrowser: false, list: false, logout: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') opts.provider = argv[++i]
    else if (a === '--no-browser') opts.noBrowser = true
    else if (a === '--list') opts.list = true
    else if (a === '--logout') opts.logout = true
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

async function openBrowser(target) {
  // Imported lazily so the bundle stays small when this path isn't used.
  const { execSync } = await import('node:child_process')
  try {
    if (process.env.OS === 'Windows_NT') {
      execSync(`start "" "${target}"`, { stdio: 'ignore' })
    } else if (process.platform === 'darwin') {
      execSync(`open "${target}"`, { stdio: 'ignore' })
    } else {
      execSync(`xdg-open "${target}"`, { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

async function confirm(provider) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`Login to ${provider.label}? [Y/n]: `)
  rl.close()
  return !/^n/i.test((answer || 'y').trim())
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    out('Usage: dsh-minimax-login [--no-browser] [--logout]')
    out('Defaults to MiniMax Global Coding Plan (api.minimax.io).')
    return
  }
  if (opts.list) {
    for (const p of DEFAULT_PROVIDER_PROFILES) out(`${p.id}\t${p.label}`)
    return
  }

  const profile = opts.provider
    ? DEFAULT_PROVIDER_PROFILES.find((p) => p.id === opts.provider)
    : DEFAULT_PROVIDER_PROFILES[0]
  if (!profile) {
    out(`Unknown provider id: ${opts.provider}`)
    process.exit(2)
  }
  if (!(await confirm(profile))) {
    out('Aborted.')
    return
  }

  const tokenPath = path.join(process.env.DSH_HOME || `${process.env.HOME}/.dsh`, 'minimax-oauth.json')
  const store = new FileCredentialStore(tokenPath)

  if (opts.logout) {
    await store.clear(profile.id)
    out(`Logged out of ${profile.label}`)
    return
  }

  out(`Starting MiniMax OAuth (${profile.label})…`)
  out(`OAuth endpoint: ${profile.oauthBaseUrl}`)
  out(`Inference endpoint: ${profile.inferenceBaseUrl}`)
  out(`Token file: ${tokenPath}`)

  if (opts.noBrowser) {
    out('')
    out('--no-browser mode: when the URL appears below, open it in your browser')
    out('and enter the user code. We will keep polling until you authorize.')
    out('')
  }

  const result = await runAuthorization(store, profile, {
    openBrowser: opts.noBrowser ? undefined : openBrowser,
    onUserCode: ({ verificationUri, userCode }) => {
      out('')
      out('──────────────────────────────────────────────')
      out(`  Open:  ${verificationUri}`)
      out(`  Code:  ${userCode}`)
      out('──────────────────────────────────────────────')
      out('Waiting for authorization...')
    },
  })
  out('')
  out(`✓ Success! Token valid until ${result.state.expires_at}`)
  out(`Token saved to ${tokenPath}`)

  // Mirror token to ~/.dsh/.env as MINIMAX_API_KEY so the built-in `pi-ai`
  // `minimax` adapter can pick it up on next launch without re-importing the
  // plugin. This matches the variable the `sync-minimax-oauth.sh` launcher
  // writes when porting a token from OpenClaw's SQLite store.
  const envKey = 'MINIMAX_API_KEY'
  const envFile = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.env` : `${process.env.HOME}/.dsh/.env`
  try {
    let existing = ''
    if (fs.existsSync(envFile)) existing = fs.readFileSync(envFile, 'utf8')
    const lines = existing.split('\n').filter((l) => !l.startsWith(`${envKey}=`))
    lines.push(`${envKey}=${result.state.access_token}`)
    fs.writeFileSync(envFile, lines.join('\n'))
    fs.chmodSync(envFile, 0o600)
    out(`Mirrored token to ${envFile} as ${envKey}`)
    out('Restart DeepSeek Harness to pick up the new key.')
  } catch (e) {
    out(`⚠ Could not mirror to ${envFile}: ${e.message}`)
  }
}

main().catch((err) => {
  out(`✗ Error: ${err.message}`)
  if (err.stack) out(err.stack.split('\n').slice(0, 5).join('\n'))
  process.exit(1)
})