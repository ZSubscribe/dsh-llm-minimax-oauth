/**
 * Unit coverage for `scripts/sync-dsh-versions.mjs`.
 *
 * The script itself is exercised end-to-end manually with `--dry-run`; these
 * tests pin the pure string/version helpers so a future refactor cannot
 * silently stop rewriting the README badge, the prerequisite bullet, or the
 * DSH-prefixed version references in source and test comments.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  badgeVersion,
  derivePluginVersion,
  rewriteDocVersions,
  rewriteReadme,
} from '../scripts/sync-dsh-versions.mjs'

const README_FIXTURE = [
  '[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)',
  '',
  '- **DeepSeek Harness** `0.2.1-rc.5` (pinned exactly, matching the DSH',
  '  `0.2.1` release convention where the harness packages pin their peers to',
  '  an exact version)',
  '',
  'This plugin targets **DeepSeek Harness `0.2.1-rc.5`**. The `0.2.x` line',
].join('\n')

test('derivePluginVersion strips the prerelease suffix', () => {
  assert.equal(derivePluginVersion('0.2.2-rc.1'), '0.2.2')
  assert.equal(derivePluginVersion('0.3.0'), '0.3.0')
  assert.throws(() => derivePluginVersion('v0.2.2'), /not a DSH version/)
})

test('badgeVersion encodes the prerelease separator for shields.io', () => {
  assert.equal(badgeVersion('0.2.2-rc.1'), '0.2.2--rc.1')
  assert.equal(badgeVersion('0.3.0'), '0.3.0')
})

test('rewriteReadme updates badge, prerequisite, target and release line', () => {
  const out = rewriteReadme(README_FIXTURE, '0.2.2-rc.1')

  assert.match(out, /DeepSeek%20Harness-0\.2\.2--rc\.1-blueviolet/)
  assert.match(out, /- \*\*DeepSeek Harness\*\* `0\.2\.2-rc\.1`/)
  assert.match(out, /targets \*\*DeepSeek Harness `0\.2\.2-rc\.1`\*\*/)
  assert.match(out, /matching the DSH\n {2}`0\.2\.2` release convention/)
  assert.doesNotMatch(out, /0\.2\.1-rc\.5/)
})

test('rewriteDocVersions only touches DSH version references', () => {
  const bt = String.fromCharCode(96)
  const before = [
    ` * Harness vocabulary (DSH ${bt}0.2.1-rc.3${bt}): text`,
    ` * cordis ${bt}4.0.5${bt} stays untouched`,
  ].join('\n')

  const after = rewriteDocVersions(before, '0.2.2-rc.1')

  assert.ok(after.includes(`DSH ${bt}0.2.2-rc.1${bt}`))
  assert.ok(after.includes(`cordis ${bt}4.0.5${bt}`))
  assert.ok(!after.includes('0.2.1-rc.3'))
})
