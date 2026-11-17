# Versions

This plugin ships **one build per DeepSeek Harness build**.

The harness refuses to load a plugin whose declared DSH requirement does not
match the running runtime, and it identifies a plugin by `name@version`. So a
single build cannot serve two harness builds: the plugin version has to say
which harness build it targets, and the harness build has to be able to name
the plugin version it wants.

Every row below is a published build. Pick the row whose **DSH version** matches
the harness you run — check it with `dsh --version`, or read
`desktopVersion` from `resources/runtime/primary-runtime/runtime.json` in your
DeepSeek Harness installation.

| DSH version | Plugin version | Git tag | Branch |
| --- | --- | --- | --- |
| `0.2.2-rc.3` | `0.2.2-rc.3` | `v0.2.2-rc.3` | `main` |
| `0.2.2-rc.1` | `0.2.2-rc.1` | `v0.2.2-rc.1` | `release/dsh-0.2.2-rc.1` |

## Installing a specific build

Each build is a Git tag in this repository, so a specific harness build is
installed by pinning that tag:

```sh
dsh plugin --profile web add "https://github.com/ZSubscribe/dsh-llm-minimax-oauth.git#v0.2.2-rc.3"
```

The harness resolves the tag to a commit and installs that exact tree. If the
profile already has the plugin installed from another source, remove it first
(`dsh plugin --profile web remove dsh-llm-minimax-oauth`) — the harness
refuses a second copy of the same package.

A Git install builds the plugin from source: the package has a `prepare`
script, so pnpm runs the build after cloning. pnpm ≥10 asks for permission
first; allow it in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-llm-minimax-oauth: true
```

## What each build declares

Every build's `package.json` states its harness build twice:

- `engines.dsh` — the exact harness version this build runs on. The harness
  checks this field first and ignores the peer ranges when it is present.
- the four `@deepseek-ai/dsh-*` peer dependencies — pinned to the same exact
  version, so a resolver cannot pull a mismatched harness package in.

The plugin version equals the harness version it targets. That keeps the two
in lockstep and keeps the `name@version` identity unambiguous.

## Keeping a build alive

The source tree is shared by all builds: the adapter is written against the
`0.2.x` harness vocabulary, and the failure codes it raises are the harness'
own built-in codes, so one source tree compiles against every `0.2.x` line.
A new harness build therefore means a new build of this plugin, not a fork:

```bash
npm run sync-dsh -- 0.2.2-rc.4
```

That command updates the version, the `engines.dsh` field, the peer pins, the
README, this matrix, the source comments, and then reinstalls, rebuilds and
runs every test suite. See [Maintenance](../README.md#maintenance).
