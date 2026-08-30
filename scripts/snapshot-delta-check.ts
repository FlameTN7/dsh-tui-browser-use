#!/usr/bin/env node
/**
 * dsh-tui-browser-use — live snapshot-id + delta regression test (Phase 2.6).
 *
 * Verifies the B7 stable-snapshot-id + delta behavior on a real page:
 *   1. every snapshot node carries a stable page-internal `id`;
 *   2. the same DOM element keeps its `id` across snapshot calls (so an agent
 *      can correlate an element between snapshots);
 *   3. `delta` reports `changed` when a snapshotted element mutates;
 *   4. `delta` is capped (`truncated`) when many nodes reindex at once.
 *
 * Usage:
 *   DSH_TUI_BROWSER_EXECUTABLE=/path/to/chrome \
 *     node --import tsx/esm scripts/snapshot-delta-check.ts
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserUseConfig, SnapshotNode } from '../src/types.js'
import { BrowserSession } from '../src/browser.js'

function config(): BrowserUseConfig {
  return {
    visionMode: 'off',
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-delta-'))
  const p = join(dir, 'fixture.html')
  writeFileSync(p, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>snap</title></head>
<body>
  <h1>快照</h1>
  <button id="btn">点我</button>
  <input id="name" placeholder="姓名">
  <div id="out">初始</div>
</body></html>`)
  return p
}

function step(msg: string): void {
  process.stdout.write('[snapshot-delta] ' + msg + '\n')
}

async function main() {
  const s = new BrowserSession(config(), 'zh')
  const pageUrl = 'file://' + fixture()
  await s.navigate({ url: pageUrl })

  // 1. First snapshot establishes the baseline and allocates stable ids.
  const s1 = await s.snapshot({})
  step(`1 first snapshot nodes=${s1.nodes.length}`)
  assert.ok(s1.nodes.length >= 3, 'snapshot has >=3 nodes')
  for (const n of s1.nodes) {
    assert.ok(Number.isInteger(n.id) && n.id > 0, `node has a positive integer id (${n.id})`)
    assert.ok(n.index > 0, 'index > 0')
  }
  const btn1 = s1.nodes.find((n) => n.role === 'button' && /点我/.test(n.name))
  assert.ok(btn1, 'first snapshot lists the button')

  // 2. Second snapshot: the same element keeps its stable id.
  const s2 = await s.snapshot({})
  const btn2 = s2.nodes.find((n) => n.role === 'button' && /点我/.test(n.name))
  assert.ok(btn2, 'second snapshot lists the button')
  assert.equal(btn2.id, btn1.id, 'button keeps its stable id across snapshots')
  step(`2 stable id across snapshots: btn id=${btn1.id}`)

  // 3. Mutate a snapshotted element, then ask for a delta → `changed`.
  await s.evaluate({ expression: "document.getElementById('btn').textContent='已点'" })
  const s3 = await s.snapshot({ delta: true })
  assert.ok(s3.delta, 'delta returned when requested')
  assert.ok(Array.isArray(s3.delta.changed), 'delta.changed is a list')
  const changedBtn = s3.delta.changed?.find((n) => n.id === btn1.id)
  assert.ok(changedBtn, 'button appears in delta.changed after its text mutates')
  // The button name updated (point 我 → 已点), so the fingerprint differs.
  assert.match(changedBtn.name, /已点/, 'changed node reflects the new accessible name')
  step(`3 delta.changed matched button id=${btn1.id}`)

  // 4. Delta is capped when many nodes reindex at once (a node prepended before
  //    the rest shifts every later node's positional index).
  const tall = join(tmpdir(), 'snap-delta-tall.html')
  writeFileSync(tall, `<!doctype html><html><body style="margin:0">${Array.from({ length: 200 }, (_, i) =>
    `<button style="position:absolute;top:${i * 60}px;left:0;width:100px;height:40px">b${i}</button>`).join('')}</body></html>`)
  await s.navigate({ url: 'file://' + tall })
  await s.snapshot({}) // baseline: nodes 1..200 (b0..b199)
  await s.evaluate({ expression: "const b=document.createElement('button'); b.textContent='pre'; document.body.prepend(b);" })
  const s4 = await s.snapshot({ delta: true })
  step(`4 prepend delta: reindexed=${s4.delta?.reindexed?.length ?? 0} truncated=${s4.delta?.truncated}`)
  assert.ok(s4.delta, 'delta returned after prepend')
  assert.ok(Array.isArray(s4.delta.reindexed), 'delta.reindexed is a list')
  assert.ok((s4.delta.reindexed?.length ?? 0) > 0, 'many nodes reindexed after a prepend')
  assert.equal(s4.delta.truncated, true, 'large reindex set is capped/truncated')
  assert.ok((s4.delta.reindexed?.length ?? 0) <= 12, 'reindexed list stays within the cap')

  await s.close()
  step('ALL PASS')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
