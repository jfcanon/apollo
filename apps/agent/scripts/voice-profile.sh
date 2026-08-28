#!/usr/bin/env bash
# Switch Apollo's STT / LLM providers without editing wrangler.jsonc.
#
#   scripts/voice-profile.sh local     # Whisper (Mac) + Qwen (Mac)        — $0
#   scripts/voice-profile.sh hybrid    # Whisper (Mac) + DeepSeek cloud    — isolates the LLM
#   scripts/voice-profile.sh cloud     # Groq STT      + DeepSeek cloud    — no Mac needed
#   scripts/voice-profile.sh local --llm-model mlx-community/Qwen3-0.6B-4bit   # any override
#   scripts/voice-profile.sh show      # print the profiles
#
# Each profile is just a set of `wrangler deploy --var` overrides on top of
# wrangler.jsonc; the file stays the source of truth (its values = `local`).
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-}"; shift || true
LLM_MODEL_OVERRIDE=""; LLM_URL_OVERRIDE=""; STT_URL_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --llm-model) LLM_MODEL_OVERRIDE="$2"; shift 2 ;;
    --llm-url)   LLM_URL_OVERRIDE="$2";   shift 2 ;;
    --stt-url)   STT_URL_OVERRIDE="$2";   shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  local)
    VARS=(VOICE_PROVIDER:local
          LOCAL_LLM_URL:https://llm.ygdcbtmc4u.uk/v1
          LOCAL_LLM_MODEL:mlx-community/Qwen3.8-27B-4bit) ;;
  hybrid)
    VARS=(VOICE_PROVIDER:local
          LOCAL_LLM_URL:https://api.deepseek.com/v1
          LOCAL_LLM_MODEL:deepseek-chat) ;;
  cloud)
    VARS=(VOICE_PROVIDER:groq) ;;
  show|"")
    sed -n '2,9p' "$0"; exit 0 ;;
  *) echo "unknown profile: $PROFILE (local|hybrid|cloud|show)" >&2; exit 2 ;;
esac

[ -n "$LLM_MODEL_OVERRIDE" ] && VARS+=("LOCAL_LLM_MODEL:$LLM_MODEL_OVERRIDE")
[ -n "$LLM_URL_OVERRIDE" ]   && VARS+=("LOCAL_LLM_URL:$LLM_URL_OVERRIDE")
[ -n "$STT_URL_OVERRIDE" ]   && VARS+=("LOCAL_STT_URL:$STT_URL_OVERRIDE")

ARGS=()
for kv in "${VARS[@]}"; do ARGS+=(--var "$kv"); done
echo "Deploying profile '$PROFILE': ${VARS[*]}"
npx wrangler deploy "${ARGS[@]}"
