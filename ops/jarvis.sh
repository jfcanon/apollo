#!/usr/bin/env bash
# jarvis.sh — bring the whole local half of the Jarvis/Timon voice pipeline up
# after a reboot, and tell you honestly whether it is actually working.
#
#   ./jarvis.sh bootstrap   one-time: clone timon to a stable path, build the
#                           whisper venv (with mlx GPU backend), create the
#                           whisper-stt tunnel credentials file
#   ./jarvis.sh up          start everything that is not already running, then verify
#   ./jarvis.sh status      show what is up / down (read-only, safe any time)
#   ./jarvis.sh down        stop everything this script started
#   ./jarvis.sh logs [name] tail a log (llm | stt | tunnel-llm | tunnel-stt)
#
# Four processes have to be alive for the ESP32 to work:
#   1. llm         mlx_vlm.server  127.0.0.1:8080   local Qwen
#   2. stt         whisper_server  0.0.0.0:8787     local Whisper
#   3. tunnel-llm  cloudflared     llm.ygdcbtmc4u.uk  -> :8080
#   4. tunnel-stt  cloudflared     stt.ygdcbtmc4u.uk  -> :8787
# Apollo itself runs on Cloudflare and needs nothing after a reboot.
#
# Versioned here (apollo/ops) for NID-530; the operator page that explains it
# lives at https://jarvis-timon-showcase.pages.dev/#runbook. Every path below
# can be overridden by env (JARVIS_ROOT, QWEN_DIR, QWEN_MODEL, WHISPER_PY_BASE).
set -uo pipefail

JARVIS_ROOT="${JARVIS_ROOT:-$HOME/orca/projects/jarvis}"
TIMON_DIR="$JARVIS_ROOT/timon"
APOLLO_AGENT="$JARVIS_ROOT/apollo/apps/agent"
QWEN_DIR="${QWEN_DIR:-$HOME/qwen-local}"
QWEN_PY="$QWEN_DIR/.venv-mlx/bin/python"
QWEN_MODEL="${QWEN_MODEL:-mlx-community/Qwen3.8-27B-4bit}"
WHISPER_PY_BASE="${WHISPER_PY_BASE:-/opt/homebrew/bin/python3.12}"
WHISPER_VENV="$TIMON_DIR/scripts/.venv"

CF_DIR="$HOME/.cloudflared"
STT_TUNNEL_ID="22bf6d7c-369b-4c84-8194-08ac93fd2471"
STT_CONFIG="$CF_DIR/config-stt.yml"
STT_CRED="$CF_DIR/$STT_TUNNEL_ID.json"

LOG_DIR="$JARVIS_ROOT/.logs"
RUN_DIR="$JARVIS_ROOT/.run"
SERVICES=(llm stt tunnel-llm tunnel-stt)

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# A service is "running" if its recorded PID is alive. Tunnels have no port to probe.
pid_alive() {
  local f="$RUN_DIR/$1.pid"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null
}

# Did *something* (this script or a stray terminal) already start it?
already_up() {
  case "$1" in
    llm)        port_busy 8080 ;;
    stt)        port_busy 8787 ;;
    tunnel-llm) pgrep -f 'cloudflared tunnel .*run.* llm$' >/dev/null 2>&1 || pid_alive tunnel-llm ;;
    # The stt tunnel may also be running from an older `--token eyJ...` invocation,
    # which carries no tunnel name on the command line — so fall back to probing the hostname.
    tunnel-stt) pgrep -f 'cloudflared tunnel .*whisper-stt' >/dev/null 2>&1 || pid_alive tunnel-stt \
                || curl -sf -m 6 -o /dev/null https://stt.ygdcbtmc4u.uk/healthz ;;
  esac
}

start_bg() { # start_bg <name> <cmd...>
  local name="$1"; shift
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  echo "  starting $name ..."
  nohup "$@" >>"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
}

wait_for() { # wait_for <url> <seconds> <label>
  local url="$1" secs="$2" label="$3" i=0
  while [ "$i" -lt "$secs" ]; do
    curl -sf -m 4 -o /dev/null "$url" && { green "  ok   $label"; return 0; }
    sleep 2; i=$((i + 2))
  done
  red "  FAIL $label  ($url did not answer in ${secs}s)"; return 1
}

cmd_bootstrap() {
  echo "== bootstrap (safe to re-run) =="
  mkdir -p "$JARVIS_ROOT" "$LOG_DIR" "$RUN_DIR"

  if [ -d "$TIMON_DIR/.git" ]; then
    echo "-- timon: pulling master"
    git -C "$TIMON_DIR" fetch --quiet origin && git -C "$TIMON_DIR" checkout --quiet master && git -C "$TIMON_DIR" pull --quiet --ff-only
  else
    echo "-- timon: cloning to $TIMON_DIR"
    git clone --quiet https://github.com/jfcanon/timon.git "$TIMON_DIR"
  fi

  echo "-- whisper venv: $WHISPER_VENV"
  [ -x "$WHISPER_VENV/bin/python" ] || "$WHISPER_PY_BASE" -m venv "$WHISPER_VENV"
  "$WHISPER_VENV/bin/pip" install --quiet --upgrade pip
  "$WHISPER_VENV/bin/pip" install --quiet -r "$TIMON_DIR/scripts/requirements-whisper.txt"
  if "$WHISPER_VENV/bin/python" -c 'import mlx_whisper' 2>/dev/null; then
    green "   mlx-whisper installed (GPU backend, ~0.4 s/clip)"
  else
    warn "   mlx-whisper NOT importable — will fall back to CPU (~9 s/clip)."
    warn "   Try a different base python:  WHISPER_PY_BASE=/opt/homebrew/bin/python3.11 ./jarvis.sh bootstrap"
  fi

  if [ ! -f "$STT_CRED" ]; then
    echo "-- fetching whisper-stt tunnel credentials"
    cloudflared tunnel token --cred-file "$STT_CRED" whisper-stt && chmod 600 "$STT_CRED"
  fi
  if [ ! -f "$STT_CONFIG" ]; then
    echo "-- writing $STT_CONFIG"
    cat >"$STT_CONFIG" <<EOF
tunnel: $STT_TUNNEL_ID
credentials-file: $STT_CRED

ingress:
  - hostname: stt.ygdcbtmc4u.uk
    service: http://localhost:8787
  - service: http_status:404
EOF
  fi
  green "bootstrap done — now run: ./jarvis.sh up"
}

cmd_up() {
  [ -d "$TIMON_DIR" ] && [ -x "$WHISPER_VENV/bin/python" ] && [ -f "$STT_CONFIG" ] || {
    red "not bootstrapped yet — run: ./jarvis.sh bootstrap"; exit 1; }
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  echo "== up =="

  already_up llm  && echo "  llm  already running" || start_bg llm "$QWEN_PY" -m mlx_vlm.server \
      --model "$QWEN_MODEL" --host 127.0.0.1 --port 8080 \
      --max-kv-size 36864 --kv-bits 8 --quantized-kv-start 1024

  already_up stt && echo "  stt  already running" || ( cd "$TIMON_DIR" && \
      start_bg stt "$WHISPER_VENV/bin/python" "$TIMON_DIR/scripts/whisper_server.py" )

  already_up tunnel-llm && echo "  tunnel-llm already running" || \
      start_bg tunnel-llm cloudflared tunnel --config "$CF_DIR/config.yml" run llm
  already_up tunnel-stt && echo "  tunnel-stt already running" || \
      start_bg tunnel-stt cloudflared tunnel --config "$STT_CONFIG" run whisper-stt

  echo "== verify (first Whisper start downloads the model — can take a few minutes) =="
  local rc=0
  wait_for http://127.0.0.1:8080/v1/models      60  "llm        local  :8080" || rc=1
  wait_for http://127.0.0.1:8787/healthz       600  "stt        local  :8787" || rc=1
  wait_for https://llm.ygdcbtmc4u.uk/v1/models  60  "llm        public tunnel" || rc=1
  wait_for https://stt.ygdcbtmc4u.uk/healthz    60  "stt        public tunnel" || rc=1
  cmd_backend
  [ "$rc" -eq 0 ] && green "all four up — talk to the ESP32" || red "something is down — ./jarvis.sh logs <name>"
  return "$rc"
}

cmd_backend() {
  local b
  port_busy 8787 || { red "  stt backend: (stt is down — ./jarvis.sh up)"; return 0; }
  b=$(curl -sf -m 5 http://127.0.0.1:8787/healthz | python3 -c 'import json,sys;print(json.load(sys.stdin).get("backend","<none>"))' 2>/dev/null)
  case "$b" in
    mlx)    green "  stt backend: mlx (GPU, ~0.4 s/clip)" ;;
    faster) warn  "  stt backend: faster-whisper (CPU, ~9 s/clip) — mlx-whisper missing from the venv" ;;
    *)      warn  "  stt backend: unknown — this is the PRE-PR-13 server. Re-run ./jarvis.sh bootstrap && ./jarvis.sh down && ./jarvis.sh up" ;;
  esac
}

cmd_status() {
  echo "== status =="
  for s in "${SERVICES[@]}"; do
    already_up "$s" && green "  up    $s" || red "  down  $s"
  done
  echo "== endpoints =="
  for u in http://127.0.0.1:8080/v1/models http://127.0.0.1:8787/healthz \
           https://llm.ygdcbtmc4u.uk/v1/models https://stt.ygdcbtmc4u.uk/healthz; do
    printf '  %-45s %s\n' "$u" "$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$u")"
  done
  cmd_backend
  echo "== apollo (cloudflare, nothing to start) =="
  printf '  %-45s %s\n' "apollo /health" \
    "$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://apollo.ygdcbtmc4u.workers.dev/health)"
}

cmd_down() {
  echo "== down =="
  for s in "${SERVICES[@]}"; do
    local f="$RUN_DIR/$s.pid"
    if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
      kill "$(cat "$f")" && echo "  stopped $s"
    else
      echo "  $s not started by this script (check 'ps aux | grep -E \"mlx_vlm|whisper_server|cloudflared\"')"
    fi
    rm -f "$f"
  done
}

cmd_logs() { tail -f "$LOG_DIR/${1:-stt}.log"; }

case "${1:-status}" in
  bootstrap) cmd_bootstrap ;;
  up)        cmd_up ;;
  down)      cmd_down ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-stt}" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
