/**
 * Unit coverage for `scripts/sync-dsh-versions.mjs`.
 *
 * The script itself is exercised end-to-end manually with `--dry-run`; these
 * tests pin the pure string/version helpers so a future refactor cannot
 * silently stop rewriting the README badge, the prerequisite bullet, the
 * version matrix, or the DSH-prefixed version references in source and test
 * comments.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  badgeVersion,
  compareVersions,
  derivePluginVersion,
  rewriteDocVersions,
  rewriteReadme,
  rewriteVersionsMatrix,
  versionMatrixRow,
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

test('derivePluginVersion returns the DSH version itself', () => {
  assert.equal(derivePluginVersion('0.2.2-rc.1'), '0.2.2-rc.1')
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
  // The prerequisite bullet states the exact harness build, not a base version.
  assert.doesNotMatch(out, /matching the DSH\n {2}`0\.2\.2` release convention/)
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

test('versionMatrixRow names the DSH build, the plugin version and the tag', () => {
  const row = versionMatrixRow({
    dshVersion: '0.2.2-rc.3',
    pluginVersion: '0.2.2-rc.3',
    branch: 'main',
  })

  assert.equal(row, '| `0.2.2-rc.3` | `0.2.2-rc.3` | `v0.2.2-rc.3` | `main` |')
})

test('compareVersions orders releases above their prereleases', () => {
  assert.ok(compareVersions('0.2.2', '0.2.2-rc.3') > 0)
  assert.ok(compareVersions('0.2.2-rc.3', '0.2.2-rc.1') > 0)
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.3'), 0)
})

test('rewriteVersionsMatrix appends a row and keeps the newest first', () => {
  const bt = String.fromCharCode(96)
  const before = [
    '# Versions',
    '',
    '| DSH version | Plugin version | Git tag | Branch |',
    '| --- | --- | --- | --- |',
    `| ${bt}0.2.2-rc.1${bt} | ${bt}0.2.2-rc.1${bt} | ${bt}v0.2.2-rc.1${bt} | ${bt}main${bt} |`,
    '',
  ].join('\n')

  const after = rewriteVersionsMatrix(before, {
    dshVersion: '0.2.2-rc.3',
    pluginVersion: '0.2.2-rc.3',
    branch: 'main',
  })

  assert.match(after, /\| `0\.2\.2-rc\.3` \| `0\.2\.2-rc\.3` \| `v0\.2\.2-rc\.3` \| `main` \|/)
  assert.match(after, /\| `0\.2\.2-rc\.1` \| `0\.2\.2-rc\.1` \| `v0\.2\.2-rc\.1` \| `main` \|/)
  // The newest DSH build comes first.
  assert.ok(after.indexOf('0.2.2-rc.3') < after.indexOf('0.2.2-rc.1'))
})

test('rewriteVersionsMatrix replaces the row of a DSH build it already lists', () => {
  const bt = String.fromCharCode(96)
  const before = [
    '| DSH version | Plugin version | Git tag | Branch |',
    '| --- | --- | --- | --- |',
    `| ${bt}0.2.2-rc.3${bt} | ${bt}0.2.2${bt} | ${bt}v0.2.2${bt} | ${bt}main${bt} |`,
    '',
  ].join('\n')

  const after = rewriteVersionsMatrix(before, {
    dshVersion: '0.2.2-rc.3',
    pluginVersion: '0.2.2-rc.3',
    branch: 'release/dsh-0.2.2-rc.3',
  })

  assert.match(after, /\| `0\.2\.2-rc\.3` \| `0\.2\.2-rc\.3` \| `v0\.2\.2-rc\.3` \| `release\/dsh-0\.2\.2-rc\.3` \|/)
  assert.doesNotMatch(after, /\| `0\.2\.2-rc\.3` \| `0\.2\.2` \|/)
})
