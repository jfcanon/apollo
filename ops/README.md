# ops — things that run on the owner's Mac, not on Cloudflare

`jarvis.sh` brings up the local half of the Jarvis voice pipeline after a reboot:
local Qwen (`mlx_vlm.server`, :8080), local Whisper (`timon/scripts/whisper_server.py`, :8787)
and the two `cloudflared` tunnels (`llm`, `whisper-stt`) that expose them to the Apollo worker.

```bash
ops/jarvis.sh bootstrap   # once: clone timon, build the whisper venv, write the stt tunnel config
ops/jarvis.sh up          # after every reboot
ops/jarvis.sh status      # read-only
ops/jarvis.sh logs stt    # llm | stt | tunnel-llm | tunnel-stt
ops/jarvis.sh down
```

The full runbook (prerequisites, provider switching, what IaC does not cover, troubleshooting)
is the "Run it yourself" section of <https://jarvis-timon-showcase.pages.dev/#runbook>.

Why this repo: the script exists to feed the Apollo worker, and the companion provider switch
(`apps/agent/scripts/voice-profile.sh`) already lives here. Nothing in `ops/` is deployed —
`deploy.yml` ignores this directory.
