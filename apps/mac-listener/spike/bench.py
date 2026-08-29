"""Measure the numbers the design rests on: wake-word FA/FR, and end-of-speech latency.

Run `corpus.py` first. Everything here is offline and deterministic, so
re-running it on another Mac reproduces the tables in RESULTS.md.

    python spike/bench.py --corpus corpus

Three things this deliberately does that a naive harness gets wrong:

* **Silence is trimmed before any latency is computed.** `say` pads every clip
  with a few hundred ms of nothing, and measuring from the end of the *file*
  reports a wake latency that is better than real by exactly that padding.
* **Negatives are split by kind.** "hey darvis" and "the cats knocked the router
  off the shelf" are different questions. Pooling them produces a false-accept
  rate that describes neither.
* **The headline false-accept number is per hour of continuous conversation**,
  not per clip, because that is the failure the owner would actually notice: a
  10-minute conversation that Jarvis interrupts himself in the middle of.
"""

from __future__ import annotations

import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np
from openwakeword.model import Model
from openwakeword.vad import VAD

SAMPLE_RATE_HZ = 16000
WAKE_CHUNK_SAMPLES = 1280  # 80 ms -- openWakeWord's native step
# 30 ms, Silero's native frame. The daemon buffers across the 1280-sample wake
# chunks to feed exactly this; see jarvis_listener/vad.py for why the obvious
# 320-sample alternative truncates questions.
VAD_FRAME_SAMPLES = 480

THRESHOLDS = (0.3, 0.5, 0.7, 0.9)

# A detection blocks further detections for this long, mirroring the daemon's
# refractory window; without it one utterance counts as several.
REFRACTORY_CHUNKS = 25  # 2 s

CONVERSATION_STREAM_SECONDS = 600


def read_pcm16(path: Path) -> np.ndarray:
    with wave.open(str(path)) as handle:
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)


def trim_silence(samples: np.ndarray, frame_samples: int = 160) -> np.ndarray:
    """Drop leading/trailing near-silence so timings are measured against speech.

    Threshold is relative to the clip's own peak, which keeps it valid for the
    attenuated far-field copies as well as the clean ones.
    """
    frame_count = len(samples) // frame_samples
    if frame_count == 0:
        return samples
    frames = samples[: frame_count * frame_samples].reshape(frame_count, frame_samples)
    energies = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    if energies.max() <= 0:
        return samples

    loud = np.flatnonzero(energies > energies.max() * 0.06)
    if loud.size == 0:
        return samples
    return samples[loud[0] * frame_samples : (loud[-1] + 1) * frame_samples]


def peak_score(model: Model, samples: np.ndarray) -> float:
    model.reset()
    padded = np.concatenate(
        [
            np.zeros(SAMPLE_RATE_HZ // 2, dtype=np.int16),
            samples,
            np.zeros(SAMPLE_RATE_HZ, dtype=np.int16),
        ]
    )
    best = 0.0
    for start in range(0, len(padded) - WAKE_CHUNK_SAMPLES, WAKE_CHUNK_SAMPLES):
        best = max(
            best, float(model.predict(padded[start : start + WAKE_CHUNK_SAMPLES])["hey_jarvis"])
        )
    return best


def clip_scores(corpus_root: Path) -> dict[str, dict[str, list[float]]]:
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    scores: dict[str, dict[str, list[float]]] = {}
    for condition in ("clean", "farfield"):
        scores[condition] = {}
        for label in ("positive", "near_miss", "conversation"):
            paths = sorted((corpus_root / condition / label).glob("*.wav"))
            scores[condition][label] = [peak_score(model, read_pcm16(path)) for path in paths]
    return scores


def summarize_clips(scores: dict) -> list[dict]:
    rows = []
    for condition, labels in scores.items():
        for threshold in THRESHOLDS:
            positives = labels["positive"]
            row = {
                "condition": condition,
                "threshold": threshold,
                "positive_trials": len(positives),
                "false_rejects": sum(1 for score in positives if score < threshold),
                "median_positive_score": round(float(np.median(positives)), 4),
                "min_positive_score": round(float(min(positives)), 4),
            }
            for label in ("near_miss", "conversation"):
                negatives = labels[label]
                row[f"{label}_trials"] = len(negatives)
                row[f"{label}_false_accepts"] = sum(
                    1 for score in negatives if score >= threshold
                )
                row[f"{label}_max_score"] = round(float(max(negatives)), 4)
            rows.append(row)
    return rows


def build_conversation_stream(corpus_root: Path, condition: str) -> np.ndarray:
    """Loop the conversation clips with natural pauses up to ten minutes."""
    clip_paths = sorted((corpus_root / condition / "conversation").glob("*.wav"))
    clips = [trim_silence(read_pcm16(path)) for path in clip_paths]
    generator = np.random.default_rng(11)

    pieces: list[np.ndarray] = []
    total_samples = 0
    index = 0
    while total_samples < CONVERSATION_STREAM_SECONDS * SAMPLE_RATE_HZ:
        clip = clips[index % len(clips)]
        pause_samples = int(generator.uniform(0.25, 1.2) * SAMPLE_RATE_HZ)
        pause = generator.normal(0.0, 40.0, size=pause_samples).astype(np.int16)
        pieces.extend((clip, pause))
        total_samples += len(clip) + pause_samples
        index += 1
    return np.concatenate(pieces)


def measure_conversation_false_accepts(corpus_root: Path) -> list[dict]:
    """False wakes per hour while the owner talks about cloud architecture."""
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    rows = []
    for condition in ("clean", "farfield"):
        stream = build_conversation_stream(corpus_root, condition)
        stream_hours = len(stream) / SAMPLE_RATE_HZ / 3600
        for threshold in THRESHOLDS:
            model.reset()
            detections = 0
            refractory = 0
            for start in range(0, len(stream) - WAKE_CHUNK_SAMPLES, WAKE_CHUNK_SAMPLES):
                score = float(
                    model.predict(stream[start : start + WAKE_CHUNK_SAMPLES])["hey_jarvis"]
                )
                if refractory > 0:
                    refractory -= 1
                    continue
                if score >= threshold:
                    detections += 1
                    refractory = REFRACTORY_CHUNKS
            rows.append(
                {
                    "condition": condition,
                    "threshold": threshold,
                    "stream_minutes": round(len(stream) / SAMPLE_RATE_HZ / 60, 1),
                    "false_accepts": detections,
                    "false_accepts_per_hour": round(detections / stream_hours, 2),
                }
            )
    return rows


def measure_wake_latency(corpus_root: Path, condition: str, threshold: float) -> dict:
    """Milliseconds from the last speech sample of "hey jarvis" to the detection."""
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    latencies = []
    for path in sorted((corpus_root / condition / "positive").glob("*.wav")):
        speech = trim_silence(read_pcm16(path))
        speech_end_ms = len(speech) / SAMPLE_RATE_HZ * 1000
        model.reset()
        padded = np.concatenate([speech, np.zeros(2 * SAMPLE_RATE_HZ, dtype=np.int16)])
        for index, start in enumerate(
            range(0, len(padded) - WAKE_CHUNK_SAMPLES, WAKE_CHUNK_SAMPLES)
        ):
            score = float(model.predict(padded[start : start + WAKE_CHUNK_SAMPLES])["hey_jarvis"])
            if score >= threshold:
                fired_ms = (index + 1) * WAKE_CHUNK_SAMPLES / SAMPLE_RATE_HZ * 1000
                latencies.append(fired_ms - speech_end_ms)
                break
    return {
        "condition": condition,
        "threshold": threshold,
        "trials": len(latencies),
        "median_ms": round(float(np.median(latencies)), 1),
        "p90_ms": round(float(np.percentile(latencies, 90)), 1),
        "max_ms": round(float(max(latencies)), 1),
    }


def measure_end_of_speech(corpus_root: Path, hangover_ms: int, speech_threshold: float) -> dict:
    """How long after the user really stops does `audio_end` go out.

    Latency is measured from the last speech sample of the *trimmed* clip, so
    the hangover is the floor and anything above it is what Silero costs.
    """
    vad = VAD()
    generator = np.random.default_rng(7)
    hangover_frames = int(hangover_ms / (VAD_FRAME_SAMPLES / SAMPLE_RATE_HZ * 1000))

    latencies = []
    truncation_ms: list[float] = []
    for path in sorted((corpus_root / "eos").glob("*.wav")):
        speech = trim_silence(read_pcm16(path))
        speech_end_ms = len(speech) / SAMPLE_RATE_HZ * 1000
        # Room tone rather than digital silence: digital silence is a free win
        # no real microphone ever hands you.
        room_tone = generator.normal(0.0, 40.0, size=3 * SAMPLE_RATE_HZ).astype(np.int16)
        samples = np.concatenate([speech, room_tone])

        vad.reset_states()
        silent_frames = 0
        seen_speech = False
        for start in range(0, len(samples) - VAD_FRAME_SAMPLES, VAD_FRAME_SAMPLES):
            probability = float(
                vad.predict(samples[start : start + VAD_FRAME_SAMPLES], frame_size=VAD_FRAME_SAMPLES)
            )
            if probability >= speech_threshold:
                seen_speech = True
                silent_frames = 0
                continue
            if not seen_speech:
                continue
            silent_frames += 1
            if silent_frames < hangover_frames:
                continue
            fired_ms = (start + VAD_FRAME_SAMPLES) / SAMPLE_RATE_HZ * 1000
            # Firing before the speech ended cuts the user off mid-sentence.
            # How *much* is cut decides whether the hangover is wrong or the
            # sentence merely had a dramatic pause in it.
            if fired_ms < speech_end_ms:
                truncation_ms.append(speech_end_ms - fired_ms)
            latencies.append(fired_ms - speech_end_ms)
            break

    return {
        "hangover_ms": hangover_ms,
        "trials": len(latencies),
        "median_ms": round(float(np.median(latencies)), 1),
        "p90_ms": round(float(np.percentile(latencies, 90)), 1),
        "max_ms": round(float(max(latencies)), 1),
        "mid_sentence_truncations": len(truncation_ms),
        "median_truncation_ms": (
            round(float(np.median(truncation_ms)), 1) if truncation_ms else 0.0
        ),
        "max_truncation_ms": round(float(max(truncation_ms)), 1) if truncation_ms else 0.0,
    }


def measure_cost() -> dict:
    """Real-time factor: CPU seconds burned per second of audio, single thread."""
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    vad = VAD()
    audio = np.random.default_rng(3).normal(0, 600, size=60 * SAMPLE_RATE_HZ).astype(np.int16)
    chunk_starts = range(0, len(audio) - WAKE_CHUNK_SAMPLES, WAKE_CHUNK_SAMPLES)

    started = time.perf_counter()
    for start in chunk_starts:
        model.predict(audio[start : start + WAKE_CHUNK_SAMPLES])
    wake_seconds = time.perf_counter() - started

    started = time.perf_counter()
    for start in chunk_starts:
        vad.predict(audio[start : start + 2 * VAD_FRAME_SAMPLES], frame_size=VAD_FRAME_SAMPLES)
    vad_seconds = time.perf_counter() - started

    return {
        "audio_seconds": 60,
        "wake_rtf": round(wake_seconds / 60, 4),
        "vad_rtf": round(vad_seconds / 60, 4),
        "combined_rtf": round((wake_seconds + vad_seconds) / 60, 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=Path("corpus"))
    parser.add_argument("--out", type=Path, default=Path("spike-results.json"))
    arguments = parser.parse_args()

    report = {
        "per_clip": summarize_clips(clip_scores(arguments.corpus)),
        "conversation_false_accepts": measure_conversation_false_accepts(arguments.corpus),
        "wake_latency": [
            measure_wake_latency(arguments.corpus, condition, 0.5)
            for condition in ("clean", "farfield")
        ],
        "end_of_speech": [
            measure_end_of_speech(arguments.corpus, hangover, 0.5)
            for hangover in (500, 700, 900)
        ],
        "cost": measure_cost(),
    }

    arguments.out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
