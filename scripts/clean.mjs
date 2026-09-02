#!/usr/bin/env node
/**
 * Cross-platform `clean`: remove the `lib/` build output (审核 P0-1).
 *
 * The previous script used Unix-only `rm -rf lib`, which failed on Windows
 * (`rm` is not a builtin there). This uses `node:fs.rmSync` so it works on all
 * platforms and needs no extra dependency.
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'lib'), { recursive: true, force: true })
