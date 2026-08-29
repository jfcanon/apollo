"""The device half of the Apollo desk protocol.

The wire contract lives in `apps/agent/src/protocol/schema.ts`; this module is
the smallest Python that speaks it. Nothing here touches audio hardware or
sockets, so the whole contract is unit-testable, and
`tests/fixtures/frames.golden.json` is replayed through the real Zod schema by
`apps/agent/src/protocol/__tests__/listener.spec.ts` -- that test is what keeps
the two languages honest with each other.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Final

# Must match DEVICE_MIC_PCM_SAMPLE_RATE_HZ in apps/agent/src/voice/wav.ts.
MIC_SAMPLE_RATE_HZ: Final = 16000

# What the TTS providers emit; only used when tts_start omits sampleRate.
DEFAULT_TTS_SAMPLE_RATE_HZ: Final = 24000

DEVICE_ID: Final = "mac-listener"

# Server->device types the listener acts on. Everything else in the schema
# (dashboard, timer, reminder, mcp, background_result) targets the ESP32 screen
# or its embedded MCP server and is dropped rather than mishandled.
HANDLED_SERVER_TYPES: Final = frozenset(
    {
        "ui_state",
        "tts_start",
        "tts_end",
        "tts_aborted",
        "turn_end",
        "play_effect",
        "confirm_request",
        "confirm_close",
        "error",
    }
)


class ProtocolError(ValueError):
    """A server frame did not match the shape the schema promises."""


@dataclass(frozen=True)
class ServerMessage:
    """A parsed server->device frame, narrowed to the fields the daemon uses."""

    type: str
    state: str | None = None
    caption: str | None = None
    audio_format: str | None = None
    sample_rate_hz: int | None = None
    channels: int | None = None
    sequence: int = 0
    expects_reply: bool = False
    effect_name: str | None = None
    confirm_id: str | None = None
    summary: str | None = None
    code: str | None = None
    message: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)


def _require(payload: dict[str, Any], key: str, expected: type) -> Any:
    value = payload.get(key)
    # `bool` is a subclass of `int` in Python, so a plain isinstance check would
    # accept `True` where the schema says a number and vice versa.
    is_boolean = isinstance(value, bool)
    if not isinstance(value, expected) or is_boolean != (expected is bool):
        raise ProtocolError(f"{payload.get('type')}.{key} must be {expected.__name__}")
    return value


def parse_server_message(raw_payload: str | bytes) -> ServerMessage | None:
    """Parse one server frame. Returns None for types the listener ignores."""
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError as error:
        raise ProtocolError("frame is not JSON") from error

    if not isinstance(payload, dict):
        raise ProtocolError("frame is not an object")

    message_type = payload.get("type")
    if not isinstance(message_type, str):
        raise ProtocolError("frame has no type")
    if message_type not in HANDLED_SERVER_TYPES:
        return None

    if message_type == "ui_state":
        return ServerMessage(
            type=message_type,
            state=_require(payload, "state", str),
            caption=payload.get("caption"),
            raw=payload,
        )

    if message_type == "tts_start":
        audio_format = _require(payload, "format", str)
        sample_rate = payload.get("sampleRate")
        channels = payload.get("channels")
        sequence = payload.get("sequence")
        return ServerMessage(
            type=message_type,
            audio_format=audio_format,
            sample_rate_hz=(
                sample_rate if isinstance(sample_rate, int) else DEFAULT_TTS_SAMPLE_RATE_HZ
            ),
            channels=channels if isinstance(channels, int) else 1,
            sequence=sequence if isinstance(sequence, int) else 0,
            raw=payload,
        )

    if message_type == "turn_end":
        return ServerMessage(
            type=message_type,
            expects_reply=_require(payload, "expectsReply", bool),
            raw=payload,
        )

    if message_type == "play_effect":
        return ServerMessage(
            type=message_type, effect_name=_require(payload, "name", str), raw=payload
        )

    if message_type == "confirm_request":
        return ServerMessage(
            type=message_type,
            confirm_id=_require(payload, "id", str),
            summary=_require(payload, "summary", str),
            raw=payload,
        )

    if message_type == "confirm_close":
        return ServerMessage(
            type=message_type, confirm_id=_require(payload, "id", str), raw=payload
        )

    if message_type == "error":
        return ServerMessage(
            type=message_type,
            code=_require(payload, "code", str),
            message=_require(payload, "message", str),
            raw=payload,
        )

    return ServerMessage(type=message_type, raw=payload)


def _stamp(message: dict[str, Any], epoch_seconds: int) -> dict[str, Any]:
    # `ts` is epoch SECONDS, not milliseconds: the schema caps nothing, but the
    # console and the firmware both send seconds and the server compares them.
    if epoch_seconds < 0:
        raise ProtocolError("ts must be non-negative")
    return {**message, "ts": int(epoch_seconds)}


def build_hello(epoch_seconds: int, device_id: str = DEVICE_ID) -> dict[str, Any]:
    if not device_id:
        raise ProtocolError("deviceId must not be empty")
    return _stamp({"type": "hello", "deviceId": device_id}, epoch_seconds)


def build_wake(epoch_seconds: int) -> dict[str, Any]:
    return _stamp({"type": "wake"}, epoch_seconds)


def build_audio_end(epoch_seconds: int) -> dict[str, Any]:
    return _stamp({"type": "audio_end"}, epoch_seconds)


def build_listen_cancel(epoch_seconds: int) -> dict[str, Any]:
    return _stamp({"type": "listen_cancel"}, epoch_seconds)


def build_abort(epoch_seconds: int) -> dict[str, Any]:
    return _stamp({"type": "abort"}, epoch_seconds)


def build_confirm(epoch_seconds: int, accepted: bool) -> dict[str, Any]:
    return _stamp({"type": "confirm", "ok": accepted}, epoch_seconds)


def build_playback_ack(
    epoch_seconds: int, sequence: int, played_milliseconds: int
) -> dict[str, Any]:
    if sequence < 0 or played_milliseconds < 0:
        raise ProtocolError("playback_ack counters must be non-negative")
    return _stamp(
        {
            "type": "playback_ack",
            "sequence": int(sequence),
            "playedMilliseconds": int(played_milliseconds),
        },
        epoch_seconds,
    )


def build_telemetry(
    epoch_seconds: int,
    *,
    battery_percent: int | None = None,
    is_charging: bool | None = None,
    volume_percent: int | None = None,
    firmware_version: str | None = None,
) -> dict[str, Any]:
    """Telemetry with every unmeasurable field omitted, as the protocol expects.

    A laptop has no WiFi RSSI worth reporting through this path, so it is never
    sent; battery and charging come from `pmset`.
    """
    message: dict[str, Any] = {"type": "telemetry"}
    if battery_percent is not None:
        message["battery"] = max(0, min(100, int(battery_percent)))
    if is_charging is not None:
        message["charging"] = bool(is_charging)
    if volume_percent is not None:
        message["volume"] = max(0, int(volume_percent))
    if firmware_version is not None:
        message["firmwareVersion"] = firmware_version
    return _stamp(message, epoch_seconds)


def encode(message: dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"), sort_keys=True)
