"""Framing tests, plus the golden fixture the TypeScript side validates.

`fixtures/frames.golden.json` is written from these builders and parsed by the
real Zod schema in `apps/agent/src/protocol/__tests__/listener.spec.ts`. If a
builder here drifts from `schema.ts`, one of the two tests fails -- which is the
only cross-language guarantee available without generating code.

Regenerate the fixture after an intentional protocol change:

    UPDATE_GOLDEN=1 pytest tests/test_protocol.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from jarvis_listener import protocol

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "frames.golden.json"

# A fixed timestamp keeps the fixture byte-stable across runs.
FIXED_EPOCH_SECONDS = 1_756_400_000


def build_every_frame() -> list[dict]:
    return [
        protocol.build_hello(FIXED_EPOCH_SECONDS),
        protocol.build_hello(FIXED_EPOCH_SECONDS, "mac-listener-headphones"),
        protocol.build_wake(FIXED_EPOCH_SECONDS),
        protocol.build_audio_end(FIXED_EPOCH_SECONDS),
        protocol.build_listen_cancel(FIXED_EPOCH_SECONDS),
        protocol.build_abort(FIXED_EPOCH_SECONDS),
        protocol.build_confirm(FIXED_EPOCH_SECONDS, True),
        protocol.build_confirm(FIXED_EPOCH_SECONDS, False),
        protocol.build_playback_ack(FIXED_EPOCH_SECONDS, 0, 0),
        protocol.build_playback_ack(FIXED_EPOCH_SECONDS, 3, 1840),
        protocol.build_telemetry(FIXED_EPOCH_SECONDS),
        protocol.build_telemetry(
            FIXED_EPOCH_SECONDS,
            battery_percent=87,
            is_charging=True,
            volume_percent=60,
            firmware_version="mac-listener",
        ),
    ]


def test_golden_fixture_matches_builders() -> None:
    frames = build_every_frame()
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(json.dumps(frames, indent=2, sort_keys=True) + "\n")

    assert GOLDEN_PATH.exists(), "run UPDATE_GOLDEN=1 pytest to create the fixture"
    assert json.loads(GOLDEN_PATH.read_text()) == frames


def test_timestamps_are_epoch_seconds_not_milliseconds() -> None:
    # The console and the firmware both send seconds; milliseconds would still
    # satisfy the schema and silently skew every server-side comparison.
    frame = protocol.build_wake(FIXED_EPOCH_SECONDS)
    assert frame["ts"] == FIXED_EPOCH_SECONDS
    assert len(str(frame["ts"])) == 10


def test_negative_timestamp_is_rejected() -> None:
    with pytest.raises(protocol.ProtocolError):
        protocol.build_wake(-1)


def test_hello_requires_a_device_id() -> None:
    assert protocol.build_hello(FIXED_EPOCH_SECONDS)["deviceId"] == "mac-listener"
    with pytest.raises(protocol.ProtocolError):
        protocol.build_hello(FIXED_EPOCH_SECONDS, "")


def test_telemetry_omits_fields_it_cannot_measure() -> None:
    frame = protocol.build_telemetry(FIXED_EPOCH_SECONDS)
    assert set(frame) == {"type", "ts"}
    assert "wifiRssi" not in frame


def test_telemetry_clamps_battery_into_range() -> None:
    assert protocol.build_telemetry(FIXED_EPOCH_SECONDS, battery_percent=140)["battery"] == 100
    assert protocol.build_telemetry(FIXED_EPOCH_SECONDS, battery_percent=-5)["battery"] == 0


def test_playback_ack_rejects_negative_counters() -> None:
    with pytest.raises(protocol.ProtocolError):
        protocol.build_playback_ack(FIXED_EPOCH_SECONDS, -1, 0)
    with pytest.raises(protocol.ProtocolError):
        protocol.build_playback_ack(FIXED_EPOCH_SECONDS, 0, -1)


def test_encode_is_deterministic() -> None:
    frame = protocol.build_playback_ack(FIXED_EPOCH_SECONDS, 2, 500)
    assert protocol.encode(frame) == protocol.encode(dict(reversed(list(frame.items()))))


def test_parses_tts_start_and_defaults_the_sample_rate() -> None:
    message = protocol.parse_server_message('{"type":"tts_start","format":"pcm"}')
    assert message is not None
    assert message.sample_rate_hz == protocol.DEFAULT_TTS_SAMPLE_RATE_HZ
    assert message.channels == 1
    assert message.sequence == 0


def test_parses_tts_start_with_explicit_values() -> None:
    message = protocol.parse_server_message(
        '{"type":"tts_start","format":"pcm","sampleRate":24000,"channels":1,"sequence":4}'
    )
    assert message is not None
    assert (message.sample_rate_hz, message.channels, message.sequence) == (24000, 1, 4)


@pytest.mark.parametrize("expects_reply", [True, False])
def test_parses_turn_end(expects_reply: bool) -> None:
    raw = json.dumps({"type": "turn_end", "expectsReply": expects_reply})
    message = protocol.parse_server_message(raw)
    assert message is not None
    assert message.expects_reply is expects_reply


def test_turn_end_without_expects_reply_is_rejected() -> None:
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_server_message('{"type":"turn_end"}')


def test_turn_end_rejects_a_non_boolean_expects_reply() -> None:
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_server_message('{"type":"turn_end","expectsReply":1}')


def test_parses_error_and_play_effect() -> None:
    error = protocol.parse_server_message('{"type":"error","code":"x","message":"boom"}')
    assert error is not None and error.code == "x"

    effect = protocol.parse_server_message('{"type":"play_effect","name":"ding"}')
    assert effect is not None and effect.effect_name == "ding"


def test_ignores_frames_meant_for_the_esp32_screen() -> None:
    # These are valid protocol, just not this device's business. Returning None
    # rather than raising keeps a dashboard push from killing the connection.
    for raw in (
        '{"type":"timer","endsAt":10}',
        '{"type":"reminder","message":"stand up"}',
        '{"type":"mcp","payload":{"jsonrpc":"2.0","id":1,"method":"x"}}',
    ):
        assert protocol.parse_server_message(raw) is None


def test_malformed_frames_raise() -> None:
    for raw in ("not json", "[]", '{"noType":1}', '{"type":"ui_state"}'):
        with pytest.raises(protocol.ProtocolError):
            protocol.parse_server_message(raw)
