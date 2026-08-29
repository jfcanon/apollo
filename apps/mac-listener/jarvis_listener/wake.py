"""openWakeWord's pretrained `hey_jarvis` model, wrapped to one score per chunk.

Chosen over Porcupine (needs an access key, and the epic's budget is $0) and
over Apple's `SFSpeechRecognizer` (on-device, but a dictation engine -- running
it continuously to watch for two words costs far more than 2.7% of a core).
The measurements behind that choice are in spike/RESULTS.md.

Models are downloaded once into openWakeWord's own package directory; there is
no network call on the hot path.
"""

from __future__ import annotations

import numpy as np

MODEL_NAME = "hey_jarvis"


class WakeWordDetector:
    def __init__(self, *, threads: int = 1) -> None:
        from openwakeword.model import Model

        ensure_models_present()
        self._model = Model(
            wakeword_models=[MODEL_NAME],
            inference_framework="onnx",
            ncpu=threads,
        )

    def score(self, chunk: np.ndarray) -> float:
        """Wake confidence in [0, 1] for one 1280-sample chunk of PCM16."""
        return float(self._model.predict(chunk)[MODEL_NAME])

    def reset(self) -> None:
        """Clear the feature buffer so a new utterance cannot inherit old audio."""
        self._model.reset()


def ensure_models_present() -> None:
    """Download the ONNX models on first run; a no-op afterwards."""
    import openwakeword.utils

    openwakeword.utils.download_models([MODEL_NAME])
