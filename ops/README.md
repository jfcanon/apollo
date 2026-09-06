# ops — things that run on the owner's Mac, not on Cloudflare

`jarvis.sh` brings up the local half of the Jarvis voice pipeline after a reboot:
local Qwen (`mlx_vlm.server`, :8081 by default), local Whisper (`timon/scripts/whisper_server.py`, :8787),
local Kokoro TTS (`timon/scripts/tts_server.py`, :8788), and the three `cloudflared` tunnels
(`llm`, `whisper-stt`, `tts`) that expose them to the Apollo worker.

```bash
ops/jarvis.sh bootstrap   # once: clone timon, build venvs, write tunnel configs
ops/jarvis.sh up          # after every reboot
ops/jarvis.sh status      # read-only
ops/jarvis.sh logs stt    # llm | stt | tts | tunnel-llm | tunnel-stt | tunnel-tts
ops/jarvis.sh down
```

Key environment variables (all optional, with defaults shown):
- `JARVIS_LLM_PORT=8081` — port for local Qwen server (Lima holds 8080)
- `JARVIS_ROOT=$HOME/orca/projects/jarvis` — root for timon clone, logs, run files
- `QWEN_DIR=$HOME/qwen-local` — Qwen model cache directory
- `QWEN_MODEL=mlx-community/Qwen3.8-27B-4bit` — HuggingFace model ID
- `WHISPER_PY_BASE=/opt/homebrew/bin/python3.12` — Python for whisper/TTS venvs

The full runbook (prerequisites, provider switching, what IaC does not cover, troubleshooting)
is the "Run it yourself" section of <https://jarvis-timon-showcase.pages.dev/#runbook>.

Why this repo: the script exists to feed the Apollo worker. Voice profile switching is
env-var only (`LOCAL_TTS_VOICE`, `LOCAL_TTS_MODEL`, etc. — see `apps/agent/src/configuration/environment.d.ts`),
deployed via `wrangler deploy --var`. Nothing in `ops/` is deployed — `deploy.yml` ignores this directory.