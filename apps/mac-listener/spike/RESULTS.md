# Wake word and end-of-speech spike

Numbers behind the design decisions in NID-533. Everything here is reproducible
offline on any Mac:

```bash
python spike/corpus.py --out /tmp/spike-corpus
python spike/bench.py --corpus /tmp/spike-corpus --out /tmp/spike-final.json
```

Measured 2026-08-29 on an Apple Silicon MacBook Pro (arm64), Python 3.12,
`openwakeword` 0.6 with the `hey_jarvis_v0.1` ONNX model and Silero VAD.

## What this measures, and what it does not

The corpus is 100 clips synthesized by ten macOS `say` voices at two speaking
rates, each rendered clean and again through a far-field filter (0.35 s
exponential reverb tail, −11 dB attenuation, 18 dB SNR noise floor).

**These are synthetic voices, and the far-field condition is a filter, not a
room.** The numbers describe the *engine* — whether the model fires on the
phrase and stays quiet through a conversation. They are not a substitute for
the 20 human trials the issue asks for, which still need a person, a room and a
laptop microphone. This machine's terminal has not been granted macOS
microphone permission (`ffmpeg -f avfoundation` records digital silence), so
that half could not be run here.

## Engine choice: openWakeWord

| Option | Cost | Verdict |
|---|---|---|
| **openWakeWord `hey_jarvis_v0.1`** | $0, Apache-2.0, offline | **Chosen.** Ships the exact phrase pretrained; numbers below |
| Picovoice Porcupine | Free tier needs an account + access key | Rejected: the epic's constraint is $0 *and* no new accounts; a key is another secret to rotate |
| Apple `SFSpeechRecognizer` | $0, on-device | Rejected: a dictation engine, not a wake detector. Running it continuously to watch for two words costs orders of magnitude more than 2.7% of a core, and it has no confidence threshold to tune |

Silero VAD was chosen over webrtcvad for end-of-speech because webrtcvad is an
energy/spectral heuristic that calls fan noise speech, and because Silero ships
inside openWakeWord already — no extra dependency.

## Wake word: false rejects and false accepts

20 positives, 10 conversation negatives, 10 adversarial near-misses, per condition.

| Condition | Threshold | False rejects | Min positive score | Conversation FA | Near-miss FA |
|---|---|---|---|---|---|
| clean | 0.3 | 0/20 | 0.9935 | 0/10 | 5/10 |
| clean | **0.5** | **0/20** | 0.9935 | **0/10** | 4/10 |
| clean | 0.7 | 0/20 | 0.9935 | 0/10 | 4/10 |
| clean | 0.9 | 0/20 | 0.9935 | 0/10 | 4/10 |
| far-field | 0.3 | 0/20 | 0.9207 | 0/10 | 4/10 |
| far-field | **0.5** | **0/20** | 0.9207 | **0/10** | 3/10 |
| far-field | 0.7 | 0/20 | 0.9207 | 0/10 | 2/10 |
| far-field | 0.9 | 0/20 | 0.9207 | 0/10 | 2/10 |

The separation is enormous and the threshold barely matters: the worst positive
scores 0.92, the best ordinary-conversation clip scores 0.012. Two orders of
magnitude of headroom, so **0.5 is the default** — anywhere in 0.3–0.9 behaves
the same on real speech.

The near-miss column is the honest caveat: "hey darvis", "hey harvest" and
"okay jarvis" fire, at any threshold. That is what a 2-syllable wake word costs,
it matches how the ESP32 behaves, and the recovery is cheap — a false wake with
no speech behind it is withdrawn with `listen_cancel` after 6 s rather than
running a turn on room tone.

## Wake word: false accepts per hour of continuous conversation

The number that actually matters for a 10-minute conversation. Conversation
clips looped with natural pauses into a 10-minute stream, 2 s refractory window.

| Condition | Threshold | Stream | False accepts | Per hour |
|---|---|---|---|---|
| clean | 0.3 – 0.9 | 10.0 min | **0** | **0.00** |
| far-field | 0.3 – 0.9 | 10.0 min | **0** | **0.00** |

Zero self-interruptions in 20 minutes of synthetic cloud-architecture talk at
every threshold tested.

## Wake latency

Milliseconds from the last speech sample of "hey jarvis" to the detection
crossing 0.5. Leading and trailing silence is trimmed before measuring, so this
is not inflated by `say`'s padding.

| Condition | Median | p90 | Max |
|---|---|---|---|
| clean | 85 ms | 152 ms | 270 ms |
| far-field | 110 ms | 247 ms | 320 ms |

Under the 3-second first-word budget by two orders of magnitude; the wake word
is not where the latency goes.

## End of speech

30 whole-query clips, each followed by 3 s of room tone (not digital silence).
Latency is measured from the last speech sample to the `audio_end` decision.

| Hangover | Median | p90 | Max | Mid-sentence truncations |
|---|---|---|---|---|
| 500 ms | 520 ms | 560 ms | 570 ms | 0/30 |
| **700 ms** | **730 ms** | **770 ms** | 780 ms | **0/30** |
| 900 ms | 940 ms | 980 ms | 990 ms | 0/30 |

Silero costs 20–40 ms on top of the hangover. **700 ms is the default**: it is
the issue's suggested value, it truncates nothing, and buying the 200 ms back
by dropping to 500 ms saves less than a tenth of the turn's total latency.

### The finding that changed the implementation

The first version of this harness fed Silero **320-sample (20 ms) frames**,
because the wake chunk is 1280 samples and 480 does not divide it. That is
wrong, and measurably so — Silero is trained on 30 ms frames:

| VAD frame | Hangover | Truncations | Worst cut | Median latency |
|---|---|---|---|---|
| 320 (20 ms) | 700 ms | **5/30** | **2090 ms** | 730 ms |
| 320 (20 ms) | 900 ms | 3/30 | 1450 ms | 935 ms |
| **480 (30 ms)** | **700 ms** | **0/30** | — | 730 ms |
| 480 (30 ms) | 900 ms | 0/30 | — | 940 ms |

At the convenient frame size, one question in six was cut off mid-sentence,
losing up to 2.1 seconds — and raising the hangover only masked it. The fix is
in `jarvis_listener/vad.py`: buffer across chunk boundaries and always hand
Silero exactly 480 samples, carrying the remainder into the next chunk.
`tests/test_replay.py::test_the_vad_does_not_cut_the_question_short` is the
regression guard.

## CPU cost

Single thread, 60 s of audio, ONNX runtime on CPU:

| Component | Real-time factor |
|---|---|
| Wake word | 0.0272 |
| Silero VAD | 0.0023 |
| **Combined** | **0.0295** |

About 3% of one core to listen continuously. Idle battery impact is negligible;
nothing here needs the GPU, so it does not compete with the local Qwen/Whisper
processes `ops/jarvis.sh` brings up.

## Still owed by a human

- 20 human trials of "hey jarvis" with the laptop mic across the room, and 20
  with headphones — FA/FR on a real voice in a real room.
- The end-to-end demo: "hey jarvis, what does CI/CD mean?" with no keyboard.

`README.md` has the procedure for both.
