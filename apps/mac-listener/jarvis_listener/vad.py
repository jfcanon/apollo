"""Silero VAD, used for one decision: has the owner stopped talking.

Silero rather than webrtcvad because webrtcvad is an energy/spectral heuristic
that calls fan noise and keyboard clatter speech, which turns every pause into
a truncated question. Silero ships inside openWakeWord already, so it costs no
extra dependency and 0.6% of a core (spike/RESULTS.md).

**Frame size is not a free parameter.** Silero is trained on 30 ms frames, and
the wake chunk is 1280 samples, which 480 does not divide. Feeding it the
largest divisor instead (320 samples, 20 ms) measurably breaks it: in the spike
it declared end-of-speech in the middle of 5 of 30 questions, cutting up to
2.1 s off them, while 480-sample frames truncated none at the same hangover and
the same latency. So this class buffers across chunk boundaries and always
feeds Silero exactly what it expects, carrying the remainder into the next
chunk.
"""

from __future__ import annotations

import numpy as np

# 30 ms at 16 kHz: Silero's native frame. See the module docstring before
# changing this -- the obvious "make it divide the chunk" simplification is the
# bug this class exists to avoid.
FRAME_SAMPLES = 480


class SpeechDetector:
    def __init__(self, *, threads: int = 1) -> None:
        from openwakeword.vad import VAD

        self._vad = VAD(n_threads=threads)
        self._carry = np.zeros(0, dtype=np.int16)
        self._last_probability = 0.0

    def speech_probability(self, chunk: np.ndarray) -> float:
        """Mean speech probability over the whole frames available in `chunk`.

        A chunk shorter than one frame contributes no new evidence, so the
        previous probability is repeated rather than reported as silence.
        """
        buffered = np.concatenate([self._carry, chunk]) if len(self._carry) else chunk
        frame_count = len(buffered) // FRAME_SAMPLES
        if frame_count == 0:
            self._carry = buffered
            return self._last_probability

        usable_length = frame_count * FRAME_SAMPLES
        self._carry = buffered[usable_length:].copy()
        self._last_probability = float(
            self._vad.predict(buffered[:usable_length], frame_size=FRAME_SAMPLES)
        )
        return self._last_probability

    def reset(self) -> None:
        self._vad.reset_states()
        self._carry = np.zeros(0, dtype=np.int16)
        self._last_probability = 0.0
