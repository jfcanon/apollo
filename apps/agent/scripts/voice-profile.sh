#!/usr/bin/env bash
# voice-profile.sh — switch the active TTS voice profile for the Apollo Worker.
#
# Voice profile is controlled by Worker environment variables (LOCAL_TTS_VOICE,
# LOCAL_TTS_MODEL, LOCAL_TTS_URL). This script updates them via `wrangler deploy --var`
# and triggers a new deployment so the change takes effect.
#
# Usage:
#   ./voice-profile.sh              # show current profile
#   ./voice-profile.sh af_heart     # set LOCAL_TTS_VOICE=af_heart (Kokoro)
#   ./voice-profile.sh bf_isabella  # set LOCAL_TTS_VOICE=bf_isabella (Kokoro)
#   ./voice-profile.sh list         # list known Kokoro voices
#
# Known Kokoro voices (confirmed in hf hub prince-canuma/Kokoro-82M):
#   af_heart, af_bella, af_nicole, af_sarah, af_sky
#   am_adam, am_michael
#   bf_emma, bf_isabella
#   bm_george, bm_lewis
#   ef_dora, em_alex, em_santa

set -uo pipefail

APOLLO_DIR="${APOLLO_DIR:-$HOME/orca/projects/jarvis/apollo/apps/agent}"
KNOWN_VOICES=(af_heart af_bella af_nicole af_sarah af_sky am_adam am_michael bf_emma bf_isabella bm_george bm_lewis ef_dora em_alex em_santa)

show_current() {
  echo "Current voice profile (Worker vars):"
  cd "$APOLLO_DIR"
  local vars
  vars=$(wrangler secret list 2>/dev/null | grep -E 'LOCAL_TTS_(VOICE|MODEL|URL)' || true)
  if [ -n "$vars" ]; then
    echo "$vars"
  else
    echo "  (not set as secrets; check wrangler.jsonc vars)"
    grep -E 'LOCAL_TTS_(VOICE|MODEL|URL)' wrangler.jsonc | sed 's/^[[:space:]]*/  /'
  fi
}

list_voices() {
  echo "Known Kokoro voices:"
  for v in "${KNOWN_VOICES[@]}"; do
    echo "  $v"
  done
}

deploy_var() {
  local key="$1"
  local value="$2"
  echo "Deploying $key=$value ..."
  cd "$APOLLO_DIR"
  wrangler deploy --var "$key:$value"
}

case "${1:-show}" in
  show|"")
    show_current
    ;;
  list)
    list_voices
    ;;
  af_*|bf_*|bm_*|am_*|ef_*|em_*)
    if [[ ! " ${KNOWN_VOICES[*]} " =~ " ${1} " ]]; then
      echo "Warning: '$1' not in known voices list; proceeding anyway"
    fi
    deploy_var LOCAL_TTS_VOICE "$1"
    deploy_var LOCAL_TTS_MODEL "kokoro"
    echo "Voice profile updated to $1 (kokoro). Worker redeployed."
    ;;
  *)
    echo "Unknown voice: $1"
    echo "Run './voice-profile.sh list' for known voices."
    exit 1
    ;;
esac