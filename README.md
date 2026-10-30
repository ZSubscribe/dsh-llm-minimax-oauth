# dsh-llm-minimax-oauth

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%20%3E%3D24-green)](https://nodejs.org)
[![OAuth](https://img.shields.io/badge/OAuth-2.0%20PKCE-blue)](https://datatracker.ietf.org/doc/html/rfc8628)
[![Platform](https://img.shields.io/badge/MiniMax-Global%20%7C%20CN-orange)](https://platform.minimax.io)

DeepSeek Harness plugin: **MiniMax (Global and CN) OAuth / Coding Plan** via
browser login.

Registers two provider routes on DSH's LLM runtime via a custom
`LlmAdapter` — `minimax-portal` for the Global site and
`minimax-portal-cn` for the CN site. The user authorizes once per region
through a browser-based device-code PKCE flow; tokens are persisted to
`$DSH_HOME/minimax-oauth.json`, refreshed transparently when close to
expiry, and serialized into the region's env var
(`DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL` for Global,
`DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN` for CN) so the adapters can
authenticate Anthropic Messages requests with
`Authorization: Bearer <oauth_access_token>` against
`https://api.minimax.io/anthropic/v1/messages` (Global) or
`https://api.minimaxi.com/anthropic/v1/messages` (CN). The two regions
have independent credentials: signing in to one never overwrites the
other.

The built-in `pi-ai` `minimax` route (API-key path that reads
`MINIMAX_API_KEY` and sends `x-api-key`) is unchanged and remains
available for users who authenticate via API key. The OAuth path lives on
separate route ids so the two authentication channels never collide.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Harness compatibility](#harness-compatibility)
- [Install](#install)
- [Use](#use)
- [Models unlocked](#models-unlocked)
- [Authentication](#authentication)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Uninstall](#uninstall)
- [For Plugin Authors](#for-plugin-authors)
- [API Reference](#api-reference)
- [Reference](#reference)
- [License](#license)

## Prerequisites

- **DeepSeek Harness** `0.2.1-rc.5` (pinned exactly, matching the DSH
  `0.2.1` release convention where the harness packages pin their peers to
  an exact version)
- **Node.js** `^22.19.0` or `>=24.0.0`
- A MiniMax account with an active **Coding Plan** or **Credits** balance
  on [platform.minimax.io](https://platform.minimax.io) (Global) or
  [platform.minimaxi.com](https://platform.minimaxi.com) (CN). Use the
  account matching the endpoint you intend to sign in to.
- A modern browser with popups enabled (or willingness to copy the
  authorization URL manually — see [Troubleshooting](#browser-does-not-open-automatically))

## Harness compatibility

This plugin targets **DeepSeek Harness `0.2.1-rc.5`**. The `0.2.x` line
changed the LLM message model, and the adapter is written against the new
vocabulary:

| Harness fact | `0.1.x` | `0.2.x` (this plugin) |
| --- | --- | --- |
| System prompt | `GenerateOptions.system` | a leading `role: 'system'` message; `options.system` is only set by one-shot callers |
| Tool result | a `tool-result` content block inside a user message | its own `role: 'tool'` message carrying `toolCallId` and `isError` |
| Tool-call id brand | `CallId` | `ToolCallId` |
| Content blocks | text / reasoning / image / tool-call / tool-result | text / reasoning / image / file / tool-call / tool-addition / tool-removal |
| Tool declarations | flat `tools` list | flat `tools` list, plus `deferLoading` markers that the route must not put on the wire |

Consequences for this plugin's request serialization:

- The Anthropic Messages format has exactly one system slot, so the request
  system prompt and every system-role message are merged into it.
- A tool result becomes an Anthropic `tool_result` part inside a `user`
  message, which is what the Anthropic wire format expects.
- Tool-change blocks (`tool-addition` / `tool-removal`) live in developer
  messages. This route declares no `toolUpdate`, so the harness sends the
  complete tool list on every request and the developer blocks carry no
  extra information — they are dropped.
- A tool declared with `deferLoading` is not part of the wire declaration
  list, matching the built-in `pi-ai` adapter.

## Install

The plugin is registered as a DSH bundle in your active profile's
`pnpm-workspace.yaml` and `cordis.patch.yml`. The fastest install is
through `dsh plugin`, which writes both files for you:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-llm-minimax-oauth
# or, from inside the plugin checkout:
dsh plugin --profile web add .
```

Confirm the layer:

```sh
dsh --profile web --dump-config
```

A git install may ask you to allow `prepare` in the profile's
`pnpm-workspace.yaml` (pnpm ≥10 refuses lifecycle scripts otherwise):

```yaml
allowBuilds:
  dsh-llm-minimax-oauth: true
```

When the plugin ships via npm (future), the same command resolves the
package from your registry instead of the local path.

## Use

Open the Web UI at `http://127.0.0.1:3080`, go to Settings → MiniMax
OAuth. The panel shows one card per region: **MiniMax (Global)** and
**MiniMax (CN)**, each with its own login state. Click **Login with
MiniMax (Global)** or **Login with MiniMax (CN)**. A browser tab opens to
that region's MiniMax OAuth authorization page. Approve, then return to
the settings panel — status flips to "logged in" within ~5 seconds.

The two regions are independent: logging in to CN does not affect the
Global credential, and vice versa.

For headless / remote sessions, run the CLI fallback:

```sh
dsh-minimax-login                          # interactive, defaults to Global
dsh-minimax-login --provider minimax-portal-cn  # sign in to the CN site
dsh-minimax-login --no-browser             # print URL, do not auto-open
dsh-minimax-login --list                   # list provider ids
dsh-minimax-login --logout                 # clear the stored token
```

After login, set the default model in `~/.dsh/settings.yaml`:

```yaml
agent-default-model:
  provider: minimax-portal   # or minimax-portal-cn
  model: MiniMax-M3
```

## Models unlocked

Two custom providers are registered, both exposing the same catalog:

- `minimax-portal` → `https://api.minimax.io/anthropic` (Global)
- `minimax-portal-cn` → `https://api.minimaxi.com/anthropic` (CN)

Both expose `MiniMax-M3` (1M context), `MiniMax-M3.1-Flash` (1M context),
`MiniMax-M2.7`, and `MiniMax-M2.7-highspeed`.

`MiniMax-M3` is the default and recommended for the Coding Plan.

The route is **text-only**. The adapter has no access to the harness
attachment service, so it declares `inputModalities: ['text']` and the
harness projects attached images into deterministic text placeholders
instead of failing the request. An inline image never reaches the
provider.

## Screenshots

The Settings → MiniMax OAuth panel after a successful login:

![Settings panel showing logged-in state with expires timestamp](docs/screenshots/settings-logged-in.png)

The browser-side MiniMax authorization page that opens after clicking
"Login with MiniMax":

![Browser authorization page confirming Authorization Successful](docs/screenshots/browser-authorize.png)

## Authentication

Both regions authenticate with `Authorization: Bearer
<oauth_access_token>` against the region's Anthropic-compatible endpoint,
matching the MiniMax OAuth contract implemented in OpenClaw's
`extensions/minimax/provider-registration.ts`. The per-region bases are:

| Region | OAuth base | Inference base | Env var |
| --- | --- | --- | --- |
| Global | `https://account.minimax.io` | `https://api.minimax.io/anthropic` | `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL` |
| CN | `https://account.minimaxi.com` | `https://api.minimaxi.com/anthropic` | `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN` |

OAuth flow shape (device-code + PKCE S256 + state validation) is
identical for both regions:

- Device-code endpoint: `<oauth base>/oauth2/device/code`
- Token endpoint: `<oauth base>/oauth2/token`
- Client id: `78257093-7e40-4613-99e0-527b14b39113` (OpenClaw public client id)
- Scope: `group_id profile model.completion`
- Grant type: `urn:ietf:params:oauth:grant-type:user_code`
- Refresh grant: `refresh_token`

Tokens are persisted at `$DSH_HOME/minimax-oauth.json` (default
`~/.dsh/minimax-oauth.json`) and mirrored into the matching env var as a
JSON envelope (`{access, refresh, expires_at, inference_base_url,
oauth_base_url}`). One `provider_id` entry is stored per region, so both
regions can be signed in at the same time.

### Flow at a glance

```
┌──────────┐  POST /minimax-oauth/start   ┌─────────┐
│          │ ──────────────────────────▶ │         │
│          │ ◀── { userCode,             │ Server  │
│  Client  │      verificationUri }      │  (DSH)  │
│  (Web)   │                             │         │
│   UI     │ window.open(verificationUri) │         │
│          │                             │         │
│          │  GET /minimax-oauth/status  │  polls  │
│          │ ──────────────────────────▶ │  /oauth2│
│          │ ◀── { logged_in: true }     │  /token │
│          │                             │         │
│          │ writes access_token into    │         │
│          │ the region's env var        │         │
└──────────┘                             └─────────┘
                  Bearer auth ──────────────────▶ MiniMax /v1/messages
```

**Why two phases (not one)?** The browser-facing endpoint returns the
device code in <1 second. Token polling runs server-side in the
background and writes the credential to disk the moment authorization
succeeds. This keeps the HTTP connection short and avoids the
"Waiting for browser…" freeze that a blocking poll would cause. The
background poll also catches its own timeout: if the user never finishes
authorization, the failure is recorded for `/status` instead of becoming
an unhandled rejection that would terminate the DSH process.

## Troubleshooting

**Plugin loads but `/minimax-oauth/start` returns 405.** Check that the DSH
webserver route registration ran. See the build artifact — `lib/index.mjs`
must contain `ctx.effect(() => ctx.webServer.register({...}))`, not a detached
`const r = ctx.webServer.register; r(...)`. Rebuild with `pnpm run build` if
the bundle looks stale.

**Browser does not open automatically.** Popup blockers can prevent
`window.open`. Either allow popups for `127.0.0.1:3080` or use the manual
flow: copy the verification URL + user code from the Settings panel and
finish authorization in your browser.

**Authorization page says the account is unknown or the login never
completes on one region.** Global and CN are separate accounts. Use the
card (or `--provider` id) that matches the site where the Coding Plan is
active: `minimax-portal` → `account.minimax.io`,
`minimax-portal-cn` → `account.minimaxi.com`.

**Login reports "Token Plan usage limit reached".** Account quota exhausted;
the OAuth handshake succeeded, but the model endpoint returned 429. Wait for
quota reset or upgrade the plan on MiniMax's Token Plan page.

**`MiniMax OAuth refresh failed: invalid_grant`.** The stored refresh token
was revoked or expired (server-side policy). Run `dsh-minimax-login
--logout` (add `--provider minimax-portal-cn` for the CN region) and
re-authorize.

**`MiniMax OAuth timed out before authorization completed`.** The user did
not finish authorization within the device-code lifetime (default ~10 min).
The background poll records this for the Settings panel and stays alive —
the DSH host no longer crashes when a login is left pending. Re-run the
login flow.

**`dsh plugin add` fails with `prepare script denied`.** pnpm ≥10 refuses to
run install scripts by default. Edit the profile's `pnpm-workspace.yaml`
and add the `allowBuilds` snippet from [Install](#install).

## Security

- Tokens are persisted at `$DSH_HOME/minimax-oauth.json` with `0600` perms.
  Do not commit or share this file.
- The OAuth `refresh_token` is sensitive — anyone with access can mint
  access tokens until explicitly revoked from your MiniMax account settings.
- The plugin never logs full token values; the adapter logs only redacted
  previews during error paths.
- `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL` and
  `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN` are process-local env vars
  mirroring the persisted region tokens; they are not exported or sourced
  from any shell rc file by this plugin.
- The plugin does not enable telemetry, analytics, or outbound network
  calls beyond the MiniMax OAuth endpoints and the model API.

## Uninstall

```sh
dsh plugin --profile web remove dsh-llm-minimax-oauth
```

Then remove the persisted credentials:

```sh
rm -f ~/.dsh/minimax-oauth.json
unset DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL
unset DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN
```

The built-in `pi-ai` `minimax` route (API-key path) is untouched and remains
usable after uninstall.

## For Plugin Authors

This plugin is a working reference for **registering routes through
`ctx.effect()`** in a DSH web bundle. Two patterns to copy:

```ts
// Direct method call — preserves `this` binding via the Reflect proxy.
// NEVER detach the reference (`const r = ctx.webServer.register; r(...)`),
// because the unbound method call crashes inside the WebServer with
// `Cannot read properties of undefined (reading 'exact')`.
ctx.effect(
  () => ctx.webServer.register({ kind: 'exact', path: '/your/path', handler: ... }),
  'descriptive-label',
)

// Client-side slot registration — `slots` must be declared in `inject`.
ctx.effect(
  () => ctx.slots.inject('your.slot.name', () =>
    ctx.slots.register({ name: 'your.slot.name', ... }, YourComponent)),
  'label',
)
```

The plugin also shows the **2-phase OAuth pattern**: server returns
device-code + user code immediately, browser opens the URL, polling
runs in the background. Avoid blocking the HTTP request on long-running
device-code flows.

## API Reference

`src/index.ts` exports the runtime pieces:

```ts
import {
  // LlmAdapter registered against the `minimax-portal` route
  MiniMaxAdapter,
  // File-backed token store with atomic writes
  FileCredentialStore,
  // OAuth error class with stable `.code` values
  MiniMaxOAuthError,
  // OAuth helpers (2-phase)
  startAuthorization,  // phase 1: request device code, return userCode + verificationUri
  waitForToken,        // phase 2: poll for token, persist state
  // Access helpers
  resolveAccessToken,   // returns a valid access_token, refreshing if expired
  refreshAccessToken,   // force-refresh using stored refresh_token
  // Token envelope serialization (for env var mirroring)
  readSerializedToken,
  // Brand constructors for the harness message vocabulary
  MessageId,        // brand a message identity
  ToolCallId,       // brand a tool-call correlation
  // Constants
  MINIMAX_PROVIDER_ID, MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_PROVIDER_ID_CN, MINIMAX_INFERENCE_ENV_VAR_CN,
  DEFAULT_PROVIDER_PROFILES,
  MINIMAX_DEFAULT_MODEL_CATALOG, ...,
} from 'dsh-llm-minimax-oauth'
```

The `dsh.client` slot registration lives in `src/client/apply.ts`. The
React UI for the Settings panel is in `src/client/index.tsx`.

## Reference

OAuth flow shape mirrors OpenClaw's reference implementation:
<https://github.com/openclaw/openclaw/blob/main/extensions/minimax/oauth.ts>

Endpoint URLs, scope, client id, PKCE method, grant type, and
refresh-token handling are identical.

## License

[MIT](LICENSE) — Copyright (c) 2026 Bambang Saputra Jaya.
