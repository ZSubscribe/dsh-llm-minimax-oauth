/**
 * Lifecycle tests for the plugin's `apply()` surface.
 *
 * These tests exercise the background device-code poll without a real MiniMax
 * endpoint. The regression they guard is a crash: after `POST /start` the poll
 * runs unattended for up to the device-code lifetime, and if the user never
 * finishes the browser step it fails minutes later. That failure used to be an
 * unhandled promise rejection, which Node treats as fatal and which took the
 * whole DSH host down. The poll must now record the error and resolve instead.
 *
 * The tests also cover region isolation: a CN login must write the CN env var
 * (and store entry) and leave the Global credential untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_INFERENCE_ENV_VAR_CN,
  MINIMAX_PROVIDER_ID,
  MINIMAX_PROVIDER_ID_CN,
} from '../lib/index.mjs'

/** Minimal stand-in for the cordis `Context` pieces `apply()` touches. */
function makeCtx() {
  const provided = {}
  const disposers = []
  const ctx = {
    reflect: {
      provide(key, value) {
        provided[key] = value
      },
    },
    llm: {
      registerAdapter() {},
      registerConfigurableProviders() {},
    },
    webServer: {
      register() {
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  return { ctx, provided, disposers }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Number of device-code requests served by the most recent `installFetch`
 * stub. Used to prove that a retry after a terminal error really obtains a
 * fresh device code instead of reusing the dead flow.
 */
let deviceCodeRequests = 0

/**
 * Install a fetch stub that serves the device-code endpoint and delegates the
 * token endpoint to `onToken`. The device-code response echoes the PKCE state
 * from the request, which `requestDeviceCode` validates.
 */
function installFetch({ userCode = 'TEST-CODE', expiredIn = 3600, onToken }) {
  deviceCodeRequests = 0
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith('/oauth2/device/code')) {
      deviceCodeRequests += 1
      const form = new URLSearchParams(init.body)
      return jsonResponse(200, {
        user_code: userCode,
        verification_uri: 'https://account.minimax.io/device',
        expired_in: expiredIn,
        interval: 2000,
        state: form.get('state'),
      })
    }
    if (u.pathname.endsWith('/oauth2/token')) {
      return onToken(init)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  return () => {
    globalThis.fetch = original
  }
}

async function waitFor(fn, label, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Fresh DSH home + clean region env vars for one test. */
async function setupHome() {
  const dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-apply-'))
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    globalToken: process.env[MINIMAX_INFERENCE_ENV_VAR],
    cnToken: process.env[MINIMAX_INFERENCE_ENV_VAR_CN],
  }
  process.env.DSH_HOME = dshHome
  delete process.env[MINIMAX_INFERENCE_ENV_VAR]
  delete process.env[MINIMAX_INFERENCE_ENV_VAR_CN]
  return {
    dshHome,
    async restore() {
      if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.DSH_HOME
      if (previous.globalToken === undefined) delete process.env[MINIMAX_INFERENCE_ENV_VAR]
      else process.env[MINIMAX_INFERENCE_ENV_VAR] = previous.globalToken
      if (previous.cnToken === undefined) delete process.env[MINIMAX_INFERENCE_ENV_VAR_CN]
      else process.env[MINIMAX_INFERENCE_ENV_VAR_CN] = previous.cnToken
      await fs.rm(dshHome, { recursive: true, force: true })
    },
  }
}

test('apply: an expired device code records a timeout and never rejects', async () => {
  const home = await setupHome()
  const restoreFetch = installFetch({
    userCode: 'TIMEOUT-CODE',
    // ~2s device-code lifetime: the first poll is pending, then the deadline
    // passes and pollForToken throws its `timeout` error.
    expiredIn: 1,
    onToken: async () => jsonResponse(200, { status: 'pending' }),
  })

  const rejections = []
  const onUnhandled = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)

  const { ctx, provided } = makeCtx()
  try {
    await apply(ctx)
    const surface = provided.minimaxOauth
    assert.ok(surface, 'apply() must provide the minimaxOauth surface')

    const started = await surface.startLogin(MINIMAX_PROVIDER_ID)
    assert.equal(started.userCode, 'TIMEOUT-CODE')

    const entry = await waitFor(async () => {
      const status = await surface.status()
      const found = status.find((item) => item.provider.id === MINIMAX_PROVIDER_ID)
      return found && typeof found.error === 'string' ? found : undefined
    }, 'the timeout error to be recorded')

    assert.match(entry.error, /timed out/i)
    // A retry must not reuse the dead flow's stale device code; it should ask
    // the portal for a new one.
    await surface.startLogin(MINIMAX_PROVIDER_ID)
    assert.equal(deviceCodeRequests, 2)
    // Simulate the UI's logout click after the failure: it must settle cleanly.
    await surface.logout(MINIMAX_PROVIDER_ID)
    assert.equal(process.env[MINIMAX_INFERENCE_ENV_VAR], undefined)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    restoreFetch()
    await home.restore()
  }

  assert.deepEqual(rejections, [], 'the background poll must not leave an unhandled rejection')
})

test('apply: CN login writes the CN provider and env var, leaving Global untouched', async () => {
  const home = await setupHome()
  const restoreFetch = installFetch({
    userCode: 'CN-CODE',
    onToken: async () =>
      jsonResponse(200, {
        status: 'success',
        access_token: 'cn-access-token',
        refresh_token: 'cn-refresh-token',
        expired_in: 3600,
      }),
  })

  const { ctx, provided } = makeCtx()
  try {
    await apply(ctx)
    const surface = provided.minimaxOauth

    await surface.startLogin(MINIMAX_PROVIDER_ID_CN)

    const serialized = await waitFor(
      () => (process.env[MINIMAX_INFERENCE_ENV_VAR_CN] ? JSON.parse(process.env[MINIMAX_INFERENCE_ENV_VAR_CN]) : undefined),
      'the CN env var to be written',
    )
    assert.equal(serialized.access, 'cn-access-token')
    assert.equal(serialized.inference_base_url, 'https://api.minimaxi.com/anthropic')
    // The Global region must not be lit up by a CN login.
    assert.equal(process.env[MINIMAX_INFERENCE_ENV_VAR], undefined)

    const persisted = await surface.store.read(MINIMAX_PROVIDER_ID_CN)
    assert.equal(persisted.provider_id, MINIMAX_PROVIDER_ID_CN)
    assert.equal(persisted.access_token, 'cn-access-token')

    const status = await surface.status()
    const cn = status.find((item) => item.provider.id === MINIMAX_PROVIDER_ID_CN)
    assert.equal(cn.logged_in, true)

    await surface.logout(MINIMAX_PROVIDER_ID_CN)
    assert.equal(process.env[MINIMAX_INFERENCE_ENV_VAR_CN], undefined)
    assert.equal(await surface.store.read(MINIMAX_PROVIDER_ID_CN), undefined)
  } finally {
    restoreFetch()
    await home.restore()
  }
})

test('apply: logout aborts a pending poll without surfacing an error', async () => {
  const home = await setupHome()
  const restoreFetch = installFetch({
    userCode: 'ABORT-CODE',
    onToken: async () => jsonResponse(200, { status: 'pending' }),
  })

  const rejections = []
  const onUnhandled = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)

  const { ctx, provided } = makeCtx()
  try {
    await apply(ctx)
    const surface = provided.minimaxOauth

    await surface.startLogin(MINIMAX_PROVIDER_ID_CN)
    // Abort while the poll is sleeping between attempts. The abort must be
    // treated as a cancellation, not as an authentication error.
    await surface.logout(MINIMAX_PROVIDER_ID_CN)

    const status = await surface.status()
    const cn = status.find((item) => item.provider.id === MINIMAX_PROVIDER_ID_CN)
    assert.equal(cn.error, undefined)
    assert.equal(cn.logged_in, false)
    assert.equal(process.env[MINIMAX_INFERENCE_ENV_VAR_CN], undefined)
    assert.equal(await surface.store.read(MINIMAX_PROVIDER_ID_CN), undefined)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    restoreFetch()
    await home.restore()
  }

  assert.deepEqual(rejections, [], 'aborting a poll must not leave an unhandled rejection')
})
