#!/usr/bin/env bash
# Start the real container dsh-tui with dsh-tui-browser-use mounted.
#
# Why this script: manually pasting the multi-line node invocation keeps getting
# truncated at the `\` line-continuations. This encapsulates the exact command so
# you only run one line:
#
#   bash scripts/start-tui.sh
#
# It launches the dsh-tui profile under $DSH_HOME (the container's own home, NOT
# the host production /root/.dsh) with a TTY shim so dsh-tui's stdout gate passes.

set -euo pipefail

# The container's dsh home. This script is for the CONTAINER (/opt/dsh-home);
# it refuses to run against the host production /root/.dsh. Only an explicit
# DSH_HOME=... overrides it.
if [ "${DSH_HOME:-}" = "/root/.dsh" ]; then
  echo "[start-tui] Refusing to run against host production DSH_HOME=/root/.dsh" >&2
  echo "[start-tui] Pass DSH_HOME=/opt/dsh-home (the container home) explicitly." >&2
  exit 1
fi
export DSH_HOME="${DSH_HOME:-/opt/dsh-home}"

# The container's dsh bin (never the host PATH dsh, which may point at /root/.dsh).
DSH_BIN="${DSH_BIN:-/root/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js}"
if ! [ -f "$DSH_BIN" ]; then
  echo "[start-tui] ERROR: dsh bin not found at $DSH_BIN" >&2
  echo "[start-tui] Set DSH_BIN=/path/to/the/container/dsh/bin.js" >&2
  exit 1
fi

# TTY shim so dsh-tui (which requires an interactive stdout) boots. If absent,
# write it on the fly.
FAKE_TTY=/tmp/fake-tty.cjs
if [ ! -f "$FAKE_TTY" ]; then
  cat > "$FAKE_TTY" <<'PRELOAD'
// Fake a TTY for interactive front doors that gate on isTTY.
for (const s of [process.stdout, process.stderr, process.stdin]) {
  if (!s) continue;
  try { Object.defineProperty(s, 'isTTY', { value: true, configurable: true }); } catch {}
}
PRELOAD
fi

if [ ! -f "$DSH_BIN" ]; then
  echo "[start-tui] ERROR: dsh bin not found at $DSH_BIN" >&2
  echo "[start-tui] Set DSH_BIN=/path/to/dsh-bin.js" >&2
  exit 1
fi

echo "[start-tui] DSH_HOME=$DSH_HOME  bin=$DSH_BIN" >&2
echo "[start-tui] Launching interactive dsh-tui (Ctrl-C to exit)." >&2

exec node --require "$FAKE_TTY" "$DSH_BIN" --profile dsh-tui "$@"
