"""Runtime configuration, all of it overridable by environment variable.

Defaults are the ones the spike measured (see spike/RESULTS.md), not guesses:
`wake_threshold` 0.5 and `end_of_speech_ms` 700 are where false accepts and
truncation both stayed at zero on the corpus.

No secret is ever read from here -- the device secret comes from the Keychain
(see keychain.py) and never touches a file or an argument list.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from jarvis_listener.protocol import DEVICE_ID

DEFAULT_AGENT_URL = "wss://apollo.ygdcbtmc4u.workers.dev/agents/apollo/desk"

# openWakeWord's native step. Changing it changes what the model sees, so it is
# a constant rather than a setting.
WAKE_CHUNK_SAMPLES = 1280
VAD_FRAME_SAMPLES = 320  # 1280 is an exact multiple, which Silero requires


def _read_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return fallback
    try:
        return int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from error


def _read_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return fallback
    try:
        return float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a number, got {raw!r}") from error


def _read_bool(name: str, fallback: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return fallback
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _read_optional_string(name: str) -> str | None:
    raw = os.environ.get(name)
    return raw.strip() if raw and raw.strip() else None


@dataclass(frozen=True)
class ListenerConfig:
    agent_url: str = DEFAULT_AGENT_URL
    device_id: str = DEVICE_ID

    keychain_service: str = "jarvis-listener"
    keychain_account: str = "apollo"

    input_device: str | None = None
    output_device: str | None = None

    wake_threshold: float = 0.5
    wake_refractory_ms: float = 2000.0
    speech_probability_threshold: float = 0.5

    end_of_speech_ms: float = 700.0
    no_speech_timeout_ms: float = 6000.0
    max_utterance_ms: float = 30000.0
    preroll_ms: float = 300.0

    # Off by default on purpose: on laptop speakers Jarvis's own voice trips
    # the barge-in detector and he interrupts himself every few seconds. Turn
    # it on with headphones, which is the setup the epic is aimed at.
    barge_in_enabled: bool = False
    barge_in_ms: float = 400.0

    wake_earcon: str = "chime"
    earcon_volume: float = 0.25

    telemetry_interval_seconds: int = 60
    reconnect_min_seconds: float = 1.0
    reconnect_max_seconds: float = 60.0

    def validate(self) -> None:
        if not self.agent_url.startswith(("ws://", "wss://")):
            raise ValueError(f"agent_url must be a websocket URL, got {self.agent_url!r}")
        if not 0.0 < self.wake_threshold <= 1.0:
            raise ValueError("wake_threshold must be in (0, 1]")
        if not 0.0 < self.speech_probability_threshold <= 1.0:
            raise ValueError("speech_probability_threshold must be in (0, 1]")
        if self.end_of_speech_ms <= 0 or self.max_utterance_ms <= self.end_of_speech_ms:
            raise ValueError("max_utterance_ms must exceed end_of_speech_ms, both positive")
        if self.telemetry_interval_seconds <= 0:
            raise ValueError("telemetry_interval_seconds must be positive")
        if self.reconnect_min_seconds <= 0 or self.reconnect_max_seconds < self.reconnect_min_seconds:
            raise ValueError("reconnect bounds must be positive and ordered")


def load_config() -> ListenerConfig:
    config = ListenerConfig(
        agent_url=os.environ.get("JARVIS_LISTENER_URL", DEFAULT_AGENT_URL),
        device_id=os.environ.get("JARVIS_LISTENER_DEVICE_ID", DEVICE_ID),
        keychain_service=os.environ.get("JARVIS_LISTENER_KEYCHAIN_SERVICE", "jarvis-listener"),
        keychain_account=os.environ.get("JARVIS_LISTENER_KEYCHAIN_ACCOUNT", "apollo"),
        input_device=_read_optional_string("JARVIS_LISTENER_INPUT_DEVICE"),
        output_device=_read_optional_string("JARVIS_LISTENER_OUTPUT_DEVICE"),
        wake_threshold=_read_float("JARVIS_LISTENER_WAKE_THRESHOLD", 0.5),
        speech_probability_threshold=_read_float("JARVIS_LISTENER_SPEECH_THRESHOLD", 0.5),
        end_of_speech_ms=_read_float("JARVIS_LISTENER_END_OF_SPEECH_MS", 700.0),
        no_speech_timeout_ms=_read_float("JARVIS_LISTENER_NO_SPEECH_TIMEOUT_MS", 6000.0),
        max_utterance_ms=_read_float("JARVIS_LISTENER_MAX_UTTERANCE_MS", 30000.0),
        preroll_ms=_read_float("JARVIS_LISTENER_PREROLL_MS", 300.0),
        barge_in_enabled=_read_bool("JARVIS_LISTENER_BARGE_IN", False),
        barge_in_ms=_read_float("JARVIS_LISTENER_BARGE_IN_MS", 400.0),
        telemetry_interval_seconds=_read_int("JARVIS_LISTENER_TELEMETRY_SECONDS", 60),
    )
    config.validate()
    return config
