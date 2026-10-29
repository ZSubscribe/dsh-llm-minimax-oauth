#!/usr/bin/env node
// Login script for dsh-llm-minimax-oauth
// Wraps the plugin's runAuthorization with explicit stdout flushing so output
// is visible whether running interactively or via subprocess.
//
// Supports the MiniMax Coding Plan (Global: api.minimax.io, CN: api.minimaxi.com).
import path from 'node:path'
import os from 'node:os'
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
    if (process.platform === 'win32') {
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
    out('Usage: dsh-minimax-login [--provider <id>] [--no-browser] [--list] [--logout]')
    out('')
    out('Providers:')
    for (const p of DEFAULT_PROVIDER_PROFILES) {
      out(`  ${p.id}\t${p.label} (${p.inferenceBaseUrl})`)
    }
    out('')
    out('Defaults to the Global Coding Plan (api.minimax.io).')
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

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const tokenPath = path.join(dshHome, 'minimax-oauth.json')
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

  // Mirror a Global token to ~/.dsh/.env as MINIMAX_API_KEY so the built-in
  // `pi-ai` `minimax` adapter can pick it up on next launch without
  // re-importing the plugin. The built-in provider targets api.minimax.io,
  // so a CN token must never be mirrored under that key.
  if (profile.id === DEFAULT_PROVIDER_PROFILES[0].id) {
    const envKey = 'MINIMAX_API_KEY'
    const envFile = path.join(dshHome, '.env')
    try {
      fs.mkdirSync(dshHome, { recursive: true })
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
  } else {
    out(`CN token stored for the plugin only; MINIMAX_API_KEY (api.minimax.io) was not touched.`)
  }
}

main().catch((err) => {
  out(`✗ Error: ${err.message}`)
  if (err.stack) out(err.stack.split('\n').slice(0, 5).join('\n'))
  process.exit(1)
})