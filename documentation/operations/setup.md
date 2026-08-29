# Setup

Local development uses Bun for scripts/tests and Wrangler for the Workers runtime.

## Prerequisites

- Bun
- Cloudflare account + Wrangler auth for remote bindings you exercise locally
- Secrets required by voice/search providers (for example OpenRouter)

## Install

```bash
bun install
cp .dev.vars.example .dev.vars
```

Fill `.dev.vars` with at least `DEVICE_SHARED_SECRET` and `OPENROUTER_API_KEY`, and leave `MOCK_VOICE=1` — it skips real STT/TTS *and* vector recall locally, so a dev session costs nothing in ElevenLabs credits or embedding calls.

`ELEVENLABS_API_KEY` is the one key with no graceful fallback: with `MOCK_VOICE` off and no key, ElevenLabs answers 401, `synthesizeSpeechWithElevenLabs` throws, and the turn fails with "no pude procesar ese pedido". The other two degrade to something the agent can say — `TAVILY_API_KEY` (`web_search`) returns a tool error, `RESEND_API_KEY` (`send_email`) returns "el email no está configurado todavía". Full list with prod instructions in [Deploy](deploy.md).

## Run locally

```bash
bun run dev
```

Wrangler serves the Worker (default `http://127.0.0.1:8787`). Sandbox/Containers need Docker running if you exercise that path.

## Useful scripts

From `package.json`:

| Script | Purpose |
|--------|---------|
| `bun run check` | Full quality gate: lint, format, typecheck, test |
| `bun run dev` | Local Worker via Wrangler |
| `bun run deploy` | Deploy Worker to Cloudflare |
| `bun run typecheck` | TypeScript `--noEmit` |
| `bun run lint` | Oxlint with deny-warnings |
| `bun run format` | Oxfmt write |
| `bun run format:check` | Oxfmt check without writing |
| `bun test` | Unit/integration tests |
| `bun run test:coverage` | Tests with coverage |
| `bun run types` | Regenerate Wrangler types |

## Configuration

- Worker config: `apps/agent/wrangler.jsonc`
- Local secrets: `.dev.vars` (from `.dev.vars.example`)
- Path alias `@/` → `apps/agent/src/` (see `apps/agent/tsconfig.json`)

## Mac Console Usage (Day One)

The `/console` page (`https://apollo.ygdcbtmc4u.workers.dev/console?token=<DASHBOARD_SHARED_SECRET>`) works on macOS Safari and Chrome with headphones for hands-free conversations.

### Prerequisites
- Mac with macOS 13+ (for `enumerateDevices` and `setSinkId` support)
- Headphones with microphone (AirPods, wired headset, or USB headset)
- Dashboard secret from Bitwarden (`apollo-dashboard-secret`) for the URL token
- Device secret from Bitwarden (`apollo-device-secret`) — prompted once, stored in `localStorage`

### First Run
1. Open `https://apollo.ygdcbtmc4u.workers.dev/console?token=<apollo-dashboard-secret>` in Safari or Chrome
2. Allow microphone permission when prompted
3. Enter the device secret (`apollo-device-secret`) when prompted
4. Select your headset as **Input** and **Output** device in the dropdowns (preferences persist in `localStorage`)
5. Check **Headphones (barge-in while speaking)** to enable interrupting Jarvis
6. Click **Connect** — status shows "connected", orb idle

### Controls
| Action | Mouse | Keyboard |
|--------|-------|----------|
| Push-to-talk | Hold **Talk** button | Hold **Space** (sends `hold_start`/`hold_end`) |
| Stop/abort | Click **Stop** | Press **Esc** (sends `abort`) |
| Open dialogue | Check **Open dialogue** | — |
| Barge-in | Speak over Jarvis (headphones only) | Hold **Space** while Jarvis speaks |

### Visual States
The orb and status text reflect `ui_state` from the server:
- **idle** — waiting, grey border
- **listening** — amber border, pulsing glow (mic active)
- **thinking** — dim border, subtle glow (LLM processing)
- **speaking** — bright amber border, expanded (TTS playing)
- **confirm** — confirmation modal open

### Protocol Notes
- `hello.deviceId = "mac-console"` — distinguishes Mac from ESP32 (`esp32-...`) and phone (`phone-console`) in telemetry
- Same device protocol as ESP32: `wake` → binary PCM16 16 kHz frames → `audio_end`
- Dialogue mode reopens mic automatically after `turn_end`
- Barge-in sends `abort`, stops playback, immediately rearms listening

### Troubleshooting
| Symptom | Fix |
|---------|-----|
| No audio input | Check macOS System Settings → Sound → Input selects your headset; re-select in page dropdown |
| No audio output | Check macOS System Settings → Sound → Output selects your headset; re-select in page dropdown |
| Mic permission denied | Safari: Settings → Websites → Microphone → Allow; Chrome: lock icon → Microphone → Allow |
| "connecting…" hangs | Verify device secret is correct; check browser console for WebSocket errors |
| Barge-in doesn't work | Ensure **Headphones** checkbox is checked; speaking must exceed 380 ms RMS threshold |

### Development
Local dev at `http://127.0.0.1:8787/console?token=<DASHBOARD_SHARED_SECRET>` works the same way. Use `MOCK_VOICE=1` in `.dev.vars` to skip real STT/TTS.

## Navigation

Prev: [MCP servers](../capabilities/mcp.md) · Next: [Deploy](deploy.md)
