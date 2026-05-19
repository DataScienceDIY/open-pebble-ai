#!/usr/bin/env bash
# State-machine test harness for the OWUI_DEBUG build.
#
# Setup (once): cold-start the emulator with the debug pbw + a fake-owui stub
# pointed at localhost. Then each scenario:
#  1. drives the app to IDLE (long-BACK from anywhere is idempotent),
#  2. starts a fresh log capture,
#  3. clicks emu-button sequences,
#  4. asserts the expected STATE: transitions appear in order in this
#     scenario's log,
#  5. prints PASS or FAIL.
#
# Fake-owui returns deterministic instant responses so the harness doesn't
# depend on upstream LLM latency or availability. State-machine correctness
# is what's being tested — not the model.
#
# Requirements: OWUI_DEBUG=1 pebble build && pebble install --emulator emery
# both work. The harness rebuilds and reinstalls automatically.

set -uo pipefail
cd "$(dirname "$0")/.."

EMU=emery
TURN_MAX_WAIT=${TURN_MAX_WAIT:-15}    # short — fake-owui responds instantly
SHORT_WAIT=${SHORT_WAIT:-3}
POLL_INTERVAL=${POLL_INTERVAL:-1}
FAKE_PORT=${FAKE_PORT:-3001}
FAKE_OWUI_PID=""
LOGS_PID=""
LOG_FILE=/tmp/owui-harness.log

PASS=0
FAIL=0
FAILURES=()

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
  green() { printf '\033[32m%s\033[0m\n' "$*"; }
  red()   { printf '\033[31m%s\033[0m\n' "$*"; }
else
  bold()  { printf '%s\n' "$*"; }
  green() { printf 'PASS: %s\n' "$*"; }
  red()   { printf 'FAIL: %s\n' "$*"; }
fi

# --- process management ---

kill_emulator_processes() {
  # qemu-pebble is matched by binary name (pidof), which doesn't suffer the
  # self-match problem that pgrep -f does. pypkjs runs under `python`, so we
  # iterate python PIDs and filter by their /proc/$pid/cmdline. The harness
  # shell's exe is `bash`, not python, so this can't self-kill.
  local pid cmd
  for pid in $(pidof qemu-pebble 2>/dev/null); do
    kill -9 "$pid" 2>/dev/null || true
  done
  for pid in $(pidof python python3 2>/dev/null); do
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *pypkjs*) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
  sleep 1
}
cleanup_all() {
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
  [ -n "$LOGS_PID" ] && wait "$LOGS_PID" 2>/dev/null
  if [ -n "$FAKE_OWUI_PID" ] && kill -0 "$FAKE_OWUI_PID" 2>/dev/null; then
    kill "$FAKE_OWUI_PID" 2>/dev/null
    wait "$FAKE_OWUI_PID" 2>/dev/null
  fi
  kill_emulator_processes
}
trap 'cleanup_all' EXIT INT TERM

ensure_debug_build() {
  bold "[build] OWUI_DEBUG=1 pebble build"
  OWUI_DEBUG=1 pebble build >/dev/null 2>&1 || { red "build failed"; exit 2; }
}

start_fake_owui() {
  python3 scripts/fake-owui.py >/tmp/fake-owui-harness.log 2>&1 &
  FAKE_OWUI_PID=$!
  local n=0
  while ! curl -sS -m 1 "http://localhost:$FAKE_PORT/api/models" >/dev/null 2>&1; do
    sleep 0.3
    n=$((n + 1))
    if [ "$n" -gt 30 ]; then
      red "fake-owui failed to start; see /tmp/fake-owui-harness.log"
      exit 2
    fi
  done
}

cold_start_emulator() {
  bold "[setup] cold-starting emulator pointed at fake-owui"
  kill_emulator_processes
  OWUI_HOST="http://localhost:$FAKE_PORT" \
      OWUI_KEY="" \
      OWUI_MODEL="fake-model-a" \
      ./scripts/seed-emulator-config.sh >/dev/null
  pebble install --emulator "$EMU" >/dev/null 2>&1 || {
    sleep 5
    pebble install --emulator "$EMU" >/dev/null 2>&1 || {
      red "emulator install failed"; exit 2;
    }
  }
  sleep 3
  # Start one global log capture; scenarios slice it by line offset.
  rm -f "$LOG_FILE"
  pebble logs --emulator "$EMU" > "$LOG_FILE" 2>&1 &
  LOGS_PID=$!
  sleep 2
}

# --- log helpers ---

# Echoes the line count in the global log (the "fence" for a scenario).
log_fence() { wc -l < "$LOG_FILE" 2>/dev/null || echo 0; }

# Echoes only the log lines after the given fence — the slice for one
# scenario.
log_since() { tail -n +"$1" "$LOG_FILE" 2>/dev/null; }

# Wait until $pattern has appeared $min_count or more times in the log after
# the given fence ($3), up to $4 seconds. Returns 0 on success, 1 on timeout.
wait_for_state_after() {
  local fence=$1
  local pattern=$2
  local min_count=$3
  local max=$4
  local elapsed=0
  while [ "$elapsed" -lt "$max" ]; do
    local count
    count=$(log_since "$fence" | grep -c "STATE: $pattern" 2>/dev/null) || true
    count=${count:-0}
    if [ "$count" -ge "$min_count" ]; then return 0; fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# Returns 0 if every expected transition appears in order in the slice.
assert_transitions() {
  local fence=$1
  local name=$2
  shift 2
  local expected=("$@")
  local actual
  actual=$(log_since "$fence" | grep 'STATE:' | sed -E 's/.*STATE: //')
  local idx=0
  for t in $actual; do
    if [ "$idx" -lt "${#expected[@]}" ] && [ "$t" = "${expected[$idx]}" ]; then
      idx=$((idx + 1))
    fi
  done
  if [ "$idx" -ge "${#expected[@]}" ]; then
    green "  PASS  $name"
    PASS=$((PASS + 1))
  else
    red   "  FAIL  $name"
    echo  "         expected: ${expected[*]}"
    echo  "         got:      $(echo "$actual" | tr '\n' ' ')"
    FAIL=$((FAIL + 1))
    FAILURES+=("$name")
  fi
}

# Resets the watch app to its launch state. We do this between scenarios
# instead of pressing buttons to navigate back. Two reasons:
#  1. emery's emulator doesn't reliably fire window_long_click_subscribe
#     handlers — so we can't drive to IDLE via long-BACK reset.
#  2. Single-BACK from IDLE exits the app entirely. Once the app's gone, no
#     subsequent emu-button press reaches our handlers.
# Reinstall is fast (sub-second) while the emulator is already running.
reset_app_state() {
  pebble install --emulator "$EMU" >/dev/null 2>&1 || true
  sleep 2
}

# --- scenarios ---

scenario_single_turn() {
  bold "[1/3] single turn: SELECT from IDLE -> full cycle"
  reset_app_state
  local fence; fence=$(log_fence)
  pebble emu-button --emulator "$EMU" click select >/dev/null
  wait_for_state_after "$fence" "WAITING->SHOWING" 1 "$TURN_MAX_WAIT" || true
  assert_transitions "$fence" "single_turn" \
    "IDLE->DICTATING" "DICTATING->SENDING" "SENDING->WAITING" "WAITING->SHOWING"
}

scenario_multi_turn() {
  bold "[2/3] multi-turn: SELECT, then SELECT from SHOWING -> two cycles"
  reset_app_state
  local fence; fence=$(log_fence)
  pebble emu-button --emulator "$EMU" click select >/dev/null
  wait_for_state_after "$fence" "WAITING->SHOWING" 1 "$TURN_MAX_WAIT" || true
  pebble emu-button --emulator "$EMU" click select >/dev/null
  wait_for_state_after "$fence" "WAITING->SHOWING" 2 "$TURN_MAX_WAIT" || true
  assert_transitions "$fence" "multi_turn" \
    "IDLE->DICTATING" "DICTATING->SENDING" "SENDING->WAITING" "WAITING->SHOWING" \
    "SHOWING->DICTATING" "DICTATING->SENDING" "SENDING->WAITING" "WAITING->SHOWING"
}

scenario_back_from_showing() {
  bold "[3/3] BACK from SHOWING returns to IDLE"
  reset_app_state
  local fence; fence=$(log_fence)
  pebble emu-button --emulator "$EMU" click select >/dev/null
  wait_for_state_after "$fence" "WAITING->SHOWING" 1 "$TURN_MAX_WAIT" || true
  pebble emu-button --emulator "$EMU" click back >/dev/null
  wait_for_state_after "$fence" "SHOWING->IDLE" 1 5 || true
  assert_transitions "$fence" "back_from_showing" \
    "IDLE->DICTATING" "WAITING->SHOWING" "SHOWING->IDLE"
}

# NOTE: A long-BACK reset scenario is intentionally omitted. The emery
# emulator (pebble-tool 5.0.35, SDK 4.9.169) does not appear to dispatch
# window_long_click_subscribe handlers — both `-d N click back` and
# `push back; sleep N; release back` only fire the single_click handler.
# On real hardware long-BACK works; coverage will be exercised manually
# until the emulator's long-click behavior is fixed.

# --- run ---

ensure_debug_build
start_fake_owui
cold_start_emulator

scenario_single_turn
scenario_multi_turn
scenario_back_from_showing

echo
bold "[summary] $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  FAIL: $f"; done
  exit 1
fi
