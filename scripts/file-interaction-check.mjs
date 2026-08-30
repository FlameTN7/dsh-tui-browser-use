/**
 * file-interaction-check — pure-logic regression for H-03/H-04.
 *
 * Verifies the screenshot savePath + download path semantics that live in
 * `BrowserSession.saveScreenshots` / `splitSaveStem`:
 *   1. `splitSaveStem` keeps an extensionless path's full basename (the
 *      no-extension bug: `/tmp/multi-noext` must NOT lose its trailing char);
 *   2. `splitSaveStem` splits a normal `name.jpg` into `name` + dir;
 *   3. A leading-dot file (`.hidden`) is treated as extensionless;
 *   4. `saveScreenshots` writes a single buffer to `savePath` verbatim.
 *
 * The multi-tile write path is exercised here with a temp dir (no browser
 * needed) through `BrowserSession.saveScreenshots` using a fake session value.
 *
 * Run: `node --import tsx/esm scripts/file-interaction-check.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { splitSaveStem, BrowserSession } = await import('../src/browser.js')

// 1. splitSaveStem — extensionless path keeps its full basename (H-03 no-ext bug).
{
  const { dir, stem } = splitSaveStem('/tmp/multi-noext')
  assert.equal(dir, '/tmp/')
  assert.equal(stem, 'multi-noext')
  console.log('[1] splitSaveStem extensionless keeps full stem — OK')
}

// 2. splitSaveStem — normal extension splits basename.
{
  const { dir, stem } = splitSaveStem('/tmp/shot.jpg')
  assert.equal(dir, '/tmp/')
  assert.equal(stem, 'shot')
  console.log('[2] splitSaveStem with extension splits basename — OK')
}

// 3. splitSaveStem — leading-dot file is extensionless.
{
  const { dir, stem } = splitSaveStem('/tmp/.hidden')
  assert.equal(dir, '/tmp/')
  assert.equal(stem, '.hidden')
  console.log('[3] splitSaveStem leading-dot file preserved — OK')
}

// 4. saveScreenshots single buffer → savePath verbatim (via a session instance).
{
  const dir = mkdtempSync(join(tmpdir(), 'file-interaction-'))
  try {
    const session = new BrowserSession({}, 'en')
    const p = join(dir, 'single.png')
    const { savedPath, savedPaths } = await session.saveScreenshots([Buffer.from('x')], p, 'png')
    assert.equal(savedPath, p)
    assert.deepEqual(savedPaths, [p])
    assert.ok(existsSync(p))
    console.log('[4] saveScreenshots single buffer verbatim — OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 5. Multi-tile extensionless path writes stem-N.ext without dropping the char.
{
  const dir = mkdtempSync(join(tmpdir(), 'file-interaction-'))
  try {
    const session = new BrowserSession({}, 'en')
    const p = join(dir, 'multi-noext')
    const { savedPath, savedPaths } = await session.saveScreenshots([Buffer.from('a'), Buffer.from('b')], p, 'png')
    assert.match(savedPath, /multi-noext-1\.png$/, 'first tile keeps full stem')
    assert.equal(savedPaths.length, 2)
    assert.ok(existsSync(join(dir, 'multi-noext-1.png')))
    assert.ok(existsSync(join(dir, 'multi-noext-2.png')))
    console.log('[5] saveScreenshots multi-tile extensionless keeps full stem — OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[file-interaction-check] ALL PASS')
process.exit(0)
