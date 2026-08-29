# Mac listener

Say **"hey jarvis"**, ask, stop talking. No clicks, no keyboard.

A small Python daemon that detects the wake word and end-of-speech locally and
speaks the same device protocol the ESP32 speaks (`apps/agent/src/protocol/schema.ts`,
[Protocol](../../documentation/runtime/protocol.md)) — so it lands in the same
Durable Object session, with the same memory, tools and confirmations. It is
the `apps/bridge` pattern with a microphone: outbound WebSocket, token from the
Keychain, launchd, reconnect with backoff.

Why Python rather than Bun, like the bridge: the wake word is an ONNX model.
[openWakeWord](https://github.com/dscripka/openWakeWord) ships a pretrained
`hey_jarvis` and costs $0 offline; the alternatives and the measurements behind
that choice are in [spike/RESULTS.md](spike/RESULTS.md). The protocol code is
kept tiny and is contract-tested against the real Zod schema, so the language
split costs no type safety at the boundary.

## Install

Python 3.11 or 3.12 (3.13+ has no onnxruntime wheel for every platform yet).

```bash
cd apps/mac-listener
python3.12 -m venv .venv
.venv/bin/pip install -e .
```

Store the device secret — the same `DEVICE_SHARED_SECRET` the ESP32 carries
(Bitwarden: `apollo-device-secret`), **not** the dashboard secret. See
[Auth](../../documentation/operations/auth.md) for why they are different.

```bash
security add-generic-password -s jarvis-listener -a apollo -w '<device secret>'
```

Then check every part before opening a socket:

```bash
PYTHONPATH=. .venv/bin/python -m jarvis_listener selftest
```

```json
{ "wake_word": "ok", "vad": "ok", "audio_devices": "ok", "keychain": "ok" }
```

The first run downloads ~4 MB of ONNX models into the openWakeWord package
directory. macOS will ask for microphone permission the first time audio is
captured — grant it to the terminal (or, under launchd, to the Python binary),
otherwise **macOS hands the process a silent stream rather than an error** and
the wake word simply never fires.

## Run

```bash
PYTHONPATH=. .venv/bin/python -m jarvis_listener run
```

```
connecting to wss://apollo.ygdcbtmc4u.workers.dev/agents/apollo/desk?token=***
connected; say "hey jarvis"
listen_open wake_word
listen_closed silence
ui_state thinking
turn_end expectsReply=False
idle waiting for the wake word
```

List audio devices with `python -m jarvis_listener devices`, then pick them by
any part of the name:

```bash
JARVIS_LISTENER_INPUT_DEVICE=AirPods \
JARVIS_LISTENER_OUTPUT_DEVICE=AirPods \
PYTHONPATH=. .venv/bin/python -m jarvis_listener run
```

### At boot

`com.jarvis.listener.plist` is a LaunchAgent (not a daemon — it needs the
logged-in user's audio session, Keychain and microphone grant). Edit the two
`CHANGE_ME` paths, then:

```bash
cp com.jarvis.listener.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.jarvis.listener.plist
tail -f /tmp/jarvis-listener.log
```

## How it behaves

| | |
|---|---|
| Wake | `hey jarvis` → earcon → `wake` + 16 kHz mono PCM16 frames |
| End of speech | 700 ms of silence → `audio_end` |
| False wake | 6 s with no speech → `listen_cancel`, no turn runs |
| Runaway | 30 s cap → `audio_end` |
| Reply | `tts_start` → PCM played at the announced rate (24 kHz mono s16le) |
| Follow-up | `turn_end.expectsReply` → mic reopens with no wake word |
| Otherwise | back to waiting for "hey jarvis" |
| Barge-in | 400 ms of speech over playback → `abort`, and those words become the next turn |

Half duplex throughout: nothing captured while Jarvis is speaking is uploaded,
so his own voice never lands in the transcript of the interruption.

**Barge-in is off by default.** On laptop speakers Jarvis's own voice trips the
detector and he interrupts himself every few seconds. Turn it on with
headphones, which is the setup this is aimed at:

```bash
JARVIS_LISTENER_BARGE_IN=1
```

### Configuration

Every knob is an environment variable; the defaults are what
[spike/RESULTS.md](spike/RESULTS.md) measured.

| Variable | Default | |
|---|---|---|
| `JARVIS_LISTENER_URL` | `wss://apollo…/agents/apollo/desk` | |
| `JARVIS_LISTENER_DEVICE_ID` | `mac-listener` | Separates it from the ESP32 in telemetry |
| `JARVIS_LISTENER_INPUT_DEVICE` | system default | Substring match |
| `JARVIS_LISTENER_OUTPUT_DEVICE` | system default | Substring match |
| `JARVIS_LISTENER_WAKE_THRESHOLD` | `0.5` | 0.3–0.9 behave identically on real speech |
| `JARVIS_LISTENER_END_OF_SPEECH_MS` | `700` | |
| `JARVIS_LISTENER_NO_SPEECH_TIMEOUT_MS` | `6000` | |
| `JARVIS_LISTENER_MAX_UTTERANCE_MS` | `30000` | |
| `JARVIS_LISTENER_PREROLL_MS` | `300` | Saves the first word when the question runs into the wake phrase |
| `JARVIS_LISTENER_BARGE_IN` | `0` | |
| `JARVIS_LISTENER_BARGE_IN_MS` | `400` | |
| `JARVIS_LISTENER_TELEMETRY_SECONDS` | `60` | |

### Secrets and audio

The device secret is read from the Keychain on every start and never written to
a file, an argument list, or a log — the connection URL is redacted before it is
logged. There is deliberately no environment-variable fallback, because that is
exactly how a secret ends up in a shell history or a plist.

Audio exists only in memory. Captured chunks go to the socket and are dropped;
played chunks go to the device and are dropped. There is no debug-recording
option for the same reason.

## Known limitations

- **Confirmations are never answered.** `confirm_request` gates a tool side
  effect, and a daemon with no screen cannot know the owner agreed, so it plays
  the chime, logs the summary and lets the request expire. Answer it from
  `/console` — same session, same conversation.
- Near-miss phrases ("hey darvis", "okay jarvis") do wake it, at any threshold.
  The `listen_cancel` timeout keeps that cheap rather than free.
- `telemetry` reports battery and charging from `pmset`; `wifiRssi` is never
  sent.

## Tests

```bash
PYTHONPATH=. .venv/bin/pytest -q     # 61 tests
```

- `tests/test_protocol.py` — framing, and the golden fixture that
  `apps/agent/src/protocol/__tests__/listener.spec.ts` replays through the real
  Zod schema. That pair is what keeps Python and TypeScript honest with each
  other; regenerate the fixture with `UPDATE_GOLDEN=1 pytest tests/test_protocol.py`
  after an intentional protocol change.
- `tests/test_session.py` — microphone policy: timeouts, refractory windows,
  follow-up listening, barge-in.
- `tests/test_keychain.py` — the secret never reaches a log, including under
  `--verbose`.
- `tests/test_replay.py` — three WAVs (wake / no wake / barge-in) pushed through
  the real wake word, the real VAD and the real state machine, asserting on the
  protocol frames that come out. Nothing mocked but the socket and the speaker.

CI runs all of it on `ubuntu-latest` (`.github/workflows/ci.yml`, job
`Mac listener`) without `sounddevice`, since nothing under test touches audio
hardware.

The fixture clips are synthesized by `python spike/corpus.py --fixtures tests/fixtures`
rather than recorded, because CI has no microphone.

## Still owed by a human

The spike measured the engine offline. Two things need a person, a room and a
granted microphone permission:

1. **20 trials each way.** Say "hey jarvis" 20 times from across the room on the
   laptop mic, and 20 times on headphones; count misses. Then hold a 10-minute
   conversation and count self-interruptions. `--verbose` logs every
   `listen_open` with its reason, so counting is reading the log.
2. **The demo.** "hey jarvis, what does CI/CD mean?" from across the room, reply
   audible, no keyboard.
