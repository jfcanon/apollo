"""The four `play_effect` sounds, synthesized rather than shipped as assets.

The firmware maps effect names to flash assets; there is no flash here, and a
handful of sine envelopes sound the same as a WAV would while keeping binary
blobs out of git and audio off the disk. Generated once at import and reused.

The point of an earcon is latency (see documentation/runtime/protocol.md): the
wake tone plays the instant the wake word fires, long before the server has
anything to say.
"""

from __future__ import annotations

import numpy as np

EARCON_SAMPLE_RATE_HZ = 24000


def _tone(frequencies: tuple[float, ...], duration_seconds: float, volume: float) -> np.ndarray:
    sample_count = int(EARCON_SAMPLE_RATE_HZ * duration_seconds)
    timeline = np.arange(sample_count) / EARCON_SAMPLE_RATE_HZ
    wave = np.zeros(sample_count, dtype=np.float64)
    for frequency in frequencies:
        wave += np.sin(2 * np.pi * frequency * timeline)
    wave /= len(frequencies)

    # A raised-cosine envelope; a bare sine clicks at both ends.
    fade_samples = max(1, int(0.012 * EARCON_SAMPLE_RATE_HZ))
    envelope = np.ones(sample_count)
    fade = 0.5 * (1 - np.cos(np.linspace(0, np.pi, fade_samples)))
    envelope[:fade_samples] = fade
    envelope[-fade_samples:] = fade[::-1]
    envelope *= np.exp(-timeline * 3.0)

    return (wave * envelope * volume * 32767).astype(np.int16)


def _sequence(*parts: np.ndarray) -> np.ndarray:
    gap = np.zeros(int(0.02 * EARCON_SAMPLE_RATE_HZ), dtype=np.int16)
    joined: list[np.ndarray] = []
    for index, part in enumerate(parts):
        if index > 0:
            joined.append(gap)
        joined.append(part)
    return np.concatenate(joined)


def build_catalog(volume: float = 0.25) -> dict[str, bytes]:
    """PCM16 mono at 24 kHz, keyed by the protocol's effect names."""
    rising = _sequence(_tone((880.0,), 0.09, volume), _tone((1318.5,), 0.11, volume))
    falling = _sequence(_tone((1318.5,), 0.09, volume), _tone((880.0,), 0.11, volume))
    return {
        # `chime` doubles as the wake tone: it is the "I am listening" sound.
        "chime": rising.tobytes(),
        "ding": _tone((1046.5,), 0.16, volume).tobytes(),
        "error": _sequence(_tone((220.0, 233.1), 0.18, volume)).tobytes(),
        "low_battery": falling.tobytes(),
    }
