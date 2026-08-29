"""Build the wake-word spike corpus from macOS `say` voices.

Four sets, each rendered clean and again through a crude far-field filter so
the numbers say something about talking from across the room:

* `positive`     -- 20 x "hey jarvis"
* `near_miss`    -- adversarial rhymes ("hey travis", "hey darvis")
* `conversation` -- the cloud/DevOps and day-talk sentences this desk hears
* `eos`          -- whole queries, for the end-of-speech measurement

Synthetic voices are not human voices, and a simulated room is not a room.
This corpus measures the *engine*: whether `hey_jarvis_v0.1` fires on the
phrase and holds still through a conversation. The 20 human trials the issue
asks for still have to be run by hand -- see README.md.
"""

from __future__ import annotations

import argparse
import subprocess
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE_HZ = 16000

# Ten `say` voices that read plain prose. Novelty voices like Zarvox sing, and
# would measure the synthesizer rather than the wake word.
VOICES = (
    "Alex",
    "Samantha",
    "Daniel",
    "Karen",
    "Moira",
    "Tessa",
    "Rishi",
    "Aman",
    "Fred",
    "Kathy",
)

RATES_WPM = (155, 200)

WAKE_PHRASE = "hey jarvis"

# The near-misses that would cost a false accept. Kept separate from ordinary
# conversation because they answer a different question: pooled together they
# produce a false-accept rate that describes neither.
NEAR_MISS_PHRASES = (
    "hey travis",
    "hey darvis",
    "hey harvest",
    "hey service",
    "a jarvis",
    "hey charles",
    "they java",
    "hey jarvis is the name of my assistant",
    "hey there",
    "okay jarvis",
)

CONVERSATION_PHRASES = (
    "what does CI CD actually mean in practice",
    "what architecture does a global web app need on AWS",
    "the cats knocked the router off the shelf again",
    "I think the pipeline is failing on the terraform plan step",
    "can you explain blast radius in a multi account setup",
    "we should rotate that key vault secret before Friday",
    "the deployment went out around four in the afternoon",
    "remind me to look at the access policy migration tomorrow",
    "it rained all weekend so we stayed in with the cats",
    "how would you design the caching layer for that service",
)


def synthesize(phrase: str, voice: str, rate_wpm: int, destination: Path) -> None:
    """Render one phrase to 16 kHz mono PCM16 via `say` + ffmpeg."""
    aiff_path = destination.with_suffix(".aiff")
    subprocess.run(
        ["say", "-v", voice, "-r", str(rate_wpm), "-o", str(aiff_path), phrase],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(aiff_path),
            "-ar", str(SAMPLE_RATE_HZ), "-ac", "1", "-c:a", "pcm_s16le",
            str(destination),
        ],
        check=True,
    )
    aiff_path.unlink()


def read_pcm16(path: Path) -> np.ndarray:
    with wave.open(str(path)) as handle:
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)


def write_pcm16(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE_HZ)
        handle.writeframes(np.clip(samples, -32768, 32767).astype(np.int16).tobytes())


def apply_far_field(samples: np.ndarray, seed: int) -> np.ndarray:
    """Attenuate, add an exponential-decay room tail, mix in filtered noise.

    Not a measured impulse response -- a stand-in for the three things distance
    does to a laptop mic: less level, more reverb, worse signal-to-noise.
    """
    generator = np.random.default_rng(seed)
    signal = samples.astype(np.float32)

    tail_length = int(0.35 * SAMPLE_RATE_HZ)
    impulse = np.zeros(tail_length, dtype=np.float32)
    impulse[0] = 1.0
    impulse[generator.integers(200, tail_length, size=24)] = generator.uniform(-0.5, 0.5, size=24)
    impulse *= np.exp(-np.arange(tail_length) / (0.10 * SAMPLE_RATE_HZ))
    reverberant = np.convolve(signal, impulse)[: len(signal)]

    attenuated = reverberant * 0.28
    speech_rms = float(np.sqrt(np.mean(attenuated**2))) or 1.0
    noise = generator.normal(0.0, speech_rms / (10 ** (18 / 20)), size=len(attenuated))
    noise = np.convolve(noise, np.ones(8, dtype=np.float32) / 8.0)[: len(attenuated)]

    return attenuated + noise.astype(np.float32)


def render_set(output_root: Path, label: str, items: list[tuple[str, str, int]]) -> None:
    for condition in ("clean", "farfield"):
        (output_root / condition / label).mkdir(parents=True, exist_ok=True)

    for index, (phrase, voice, rate_wpm) in enumerate(items):
        slug = f"{index:02d}_{voice}_{rate_wpm}"
        clean_path = output_root / "clean" / label / f"{slug}.wav"
        synthesize(phrase, voice, rate_wpm, clean_path)
        write_pcm16(
            output_root / "farfield" / label / f"{slug}.wav",
            apply_far_field(read_pcm16(clean_path), seed=index),
        )
    print(f"{label}: {len(items)} clips x 2 conditions")


def spread(phrases: tuple[str, ...]) -> list[tuple[str, str, int]]:
    """Pair each phrase with a different voice and rate, so no voice dominates."""
    return [
        (phrase, VOICES[index % len(VOICES)], RATES_WPM[index % len(RATES_WPM)])
        for index, phrase in enumerate(phrases)
    ]


def build(output_root: Path) -> None:
    render_set(
        output_root,
        "positive",
        [(WAKE_PHRASE, voice, rate) for voice in VOICES for rate in RATES_WPM],
    )
    render_set(output_root, "near_miss", spread(NEAR_MISS_PHRASES))
    render_set(output_root, "conversation", spread(CONVERSATION_PHRASES))

    # End-of-speech clips: whole queries, so the VAD is measured on the tail of
    # a real sentence rather than on the two syllables of the wake word.
    eos_directory = output_root / "eos"
    eos_directory.mkdir(parents=True, exist_ok=True)
    for index, phrase in enumerate(CONVERSATION_PHRASES):
        for voice in VOICES[:3]:
            synthesize(phrase, voice, 175, eos_directory / f"{index:02d}_{voice}.wav")
    print(f"eos: {len(CONVERSATION_PHRASES) * 3} clips")


# The three clips the replay test drives the daemon with. Trailing room tone,
# not digital silence, so the VAD hangover has to do real work to find the end.
REPLAY_FIXTURES = {
    "wake": ("hey jarvis what does CI CD mean", "Alex", 1.2),
    "no_wake": ("the cats knocked the router off the shelf again", "Samantha", 1.2),
    "barge_in": ("no wait that is not what I asked", "Daniel", 0.6),
}


def build_replay_fixtures(output_root: Path) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    generator = np.random.default_rng(23)
    for name, (phrase, voice, tail_seconds) in REPLAY_FIXTURES.items():
        destination = output_root / f"{name}.wav"
        synthesize(phrase, voice, 175, destination)
        speech = read_pcm16(destination)
        room_tone = generator.normal(
            0.0, 40.0, size=int(tail_seconds * SAMPLE_RATE_HZ)
        ).astype(np.int16)
        write_pcm16(destination, np.concatenate([speech, room_tone]))
        print(f"{destination.name}: {len(speech) / SAMPLE_RATE_HZ + tail_seconds:.1f}s")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("corpus"))
    parser.add_argument(
        "--fixtures",
        type=Path,
        help="write the three replay-test clips here instead of building the corpus",
    )
    arguments = parser.parse_args()
    if arguments.fixtures is not None:
        build_replay_fixtures(arguments.fixtures)
    else:
        build(arguments.out)
