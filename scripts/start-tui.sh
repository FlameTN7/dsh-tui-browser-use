#!/usr/bin/env bash
# Start a local dsh-tui profile with dsh-tui-browser-use mounted.
#
# Usage:
#   DSH_HOME=$HOME/.dsh DSH_BIN=$(command -v dsh) bash scripts/start-tui.sh
#
# dsh-tui requires an interactive stdout, so this script injects a small TTY
# shim via --require before booting the profile.

set -euo pipefail

# Resolve the dsh home and binary from the environment; fail loudly instead of
# guessing, so the script never touches an unintended profile.
: "${DSH_HOME:?Set DSH_HOME to the dsh profile home you want to launch}"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
if [ -z "${DSH_BIN:-}" ] || [ ! -f "$DSH_BIN" ]; then
  echo "[start-tui] ERROR: dsh binary not found" >&2
  echo "[start-tui] Set DSH_BIN=/path/to/dsh (or put dsh on PATH)." >&2
  exit 1
fi

# Profile name can be overridden; default matches the plugin's host profile.
PROFILE="${DSH_TUI_PROFILE:-dsh-tui}"

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

echo "[start-tui] DSH_HOME=$DSH_HOME  bin=$DSH_BIN  profile=$PROFILE" >&2
echo "[start-tui] Launching interactive dsh-tui (Ctrl-C to exit)." >&2

exec node --require "$FAKE_TTY" "$DSH_BIN" --profile "$PROFILE" "$@"
