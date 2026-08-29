"""Microphone policy: when to wake, when to stop, when to reopen.

These drive the state machine with synthetic scores rather than audio, so every
edge the replay tests cannot reach cheaply (timeouts, refractory windows, a
turn_end that arrives before playback drains) is covered here.
"""

from __future__ import annotations

import pytest

from jarvis_listener import protocol
from jarvis_listener.config import ListenerConfig
from jarvis_listener.session import (
    BeginPlayback,
    ListenerSession,
    ListenerState,
    PlayEarcon,
    SendAudio,
    SendJson,
    StopPlayback,
)

CHUNK_MS = 80.0
SILENT_CHUNK = b"\x00\x00" * 1280


def make_session(**overrides) -> ListenerSession:
    config = ListenerConfig(**{"preroll_ms": 0.0, **overrides})
    config.validate()
    return ListenerSession(config, epoch_seconds=1_756_400_000)


def sent_types(actions) -> list[str]:
    return [action.message["type"] for action in actions if isinstance(action, SendJson)]


def feed(session: ListenerSession, *, chunks: int, wake: float, speech: float) -> list:
    actions = []
    for _ in range(chunks):
        actions.extend(session.on_audio_chunk(SILENT_CHUNK, wake, speech, CHUNK_MS))
    return actions


def wake_up(session: ListenerSession) -> list:
    return session.on_audio_chunk(SILENT_CHUNK, 0.99, 0.1, CHUNK_MS)


def test_starts_idle_and_says_hello() -> None:
    session = make_session()
    assert session.state is ListenerState.IDLE
    assert sent_types(session.start()) == ["hello"]


def test_wake_word_opens_a_listen_with_an_earcon() -> None:
    session = make_session()
    actions = wake_up(session)

    assert session.state is ListenerState.LISTENING
    assert sent_types(actions) == ["wake"]
    assert any(isinstance(action, PlayEarcon) for action in actions)


def test_below_threshold_scores_do_not_wake() -> None:
    session = make_session(wake_threshold=0.5)
    assert sent_types(feed(session, chunks=10, wake=0.49, speech=0.9)) == []
    assert session.state is ListenerState.IDLE


def test_no_audio_is_uploaded_while_idle() -> None:
    session = make_session()
    actions = feed(session, chunks=10, wake=0.0, speech=0.9)
    assert not any(isinstance(action, SendAudio) for action in actions)


def test_audio_streams_only_after_the_wake() -> None:
    session = make_session()
    wake_up(session)
    actions = feed(session, chunks=3, wake=0.0, speech=0.9)
    assert len([action for action in actions if isinstance(action, SendAudio)]) == 3


def test_silence_after_speech_ends_the_utterance() -> None:
    session = make_session(end_of_speech_ms=700.0)
    wake_up(session)
    feed(session, chunks=5, wake=0.0, speech=0.9)

    # 700 ms of silence is 8.75 chunks, so the 9th is the one that closes it.
    assert sent_types(feed(session, chunks=8, wake=0.0, speech=0.0)) == []
    assert sent_types(feed(session, chunks=1, wake=0.0, speech=0.0)) == ["audio_end"]
    assert session.state is ListenerState.THINKING


def test_a_pause_shorter_than_the_hangover_does_not_end_the_utterance() -> None:
    session = make_session(end_of_speech_ms=700.0)
    wake_up(session)
    feed(session, chunks=3, wake=0.0, speech=0.9)
    feed(session, chunks=8, wake=0.0, speech=0.0)  # 640 ms pause
    feed(session, chunks=3, wake=0.0, speech=0.9)  # speaking again resets it

    assert session.state is ListenerState.LISTENING
    assert sent_types(feed(session, chunks=8, wake=0.0, speech=0.0)) == []


def test_a_wake_with_no_speech_behind_it_is_withdrawn() -> None:
    session = make_session(no_speech_timeout_ms=400.0)
    wake_up(session)
    actions = feed(session, chunks=5, wake=0.0, speech=0.0)

    assert sent_types(actions) == ["listen_cancel"]
    assert session.state is ListenerState.IDLE


def test_an_endless_utterance_is_capped() -> None:
    session = make_session(max_utterance_ms=800.0, end_of_speech_ms=700.0)
    wake_up(session)
    actions = feed(session, chunks=10, wake=0.0, speech=0.9)

    assert sent_types(actions) == ["audio_end"]
    assert session.state is ListenerState.THINKING


def test_the_wake_word_cannot_retrigger_during_the_refractory_window() -> None:
    session = make_session(wake_refractory_ms=400.0, end_of_speech_ms=10_000.0)
    wake_up(session)
    # Still LISTENING, so a second wake score is ignored by state anyway; the
    # refractory matters once the turn returns to idle.
    actions = feed(session, chunks=2, wake=0.99, speech=0.9)
    assert sent_types(actions) == []


def test_preroll_follows_the_wake_frame_never_precedes_it() -> None:
    session = make_session(preroll_ms=240.0)
    feed(session, chunks=5, wake=0.0, speech=0.1)
    actions = wake_up(session)

    kinds = [type(action).__name__ for action in actions if isinstance(action, (SendJson, SendAudio))]
    # `wake` clears the server's audio buffer, so pre-roll sent before it would
    # be discarded and the first word of the question lost.
    assert kinds[0] == "SendJson"
    assert kinds.count("SendAudio") >= 1
    assert all(kind == "SendAudio" for kind in kinds[1:])


def test_no_audio_is_uploaded_while_jarvis_is_speaking() -> None:
    session = make_session()
    wake_up(session)
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))

    actions = feed(session, chunks=5, wake=0.0, speech=0.9)
    assert not any(isinstance(action, SendAudio) for action in actions)


def test_tts_start_opens_playback_at_the_announced_rate() -> None:
    session = make_session()
    message = protocol.parse_server_message(
        '{"type":"tts_start","format":"pcm","sampleRate":24000,"channels":1,"sequence":2}'
    )
    actions = session.on_server_message(message)

    assert actions == [BeginPlayback(sample_rate_hz=24000, channels=1, sequence=2)]
    assert session.state is ListenerState.SPEAKING


def test_turn_end_expecting_a_reply_reopens_the_mic_without_a_wake_word() -> None:
    session = make_session()
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))
    session.on_server_message(
        protocol.parse_server_message('{"type":"turn_end","expectsReply":true}')
    )
    # Still speaking: the decision waits for the speaker to drain.
    assert session.state is ListenerState.SPEAKING

    actions = session.on_playback_finished()
    assert sent_types(actions) == ["wake"]
    assert session.state is ListenerState.LISTENING


def test_turn_end_without_a_reply_returns_to_the_wake_word() -> None:
    session = make_session()
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))
    session.on_server_message(
        protocol.parse_server_message('{"type":"turn_end","expectsReply":false}')
    )

    actions = session.on_playback_finished()
    assert sent_types(actions) == []
    assert session.state is ListenerState.IDLE


def test_turn_end_with_nothing_playing_applies_immediately() -> None:
    # An error turn sends turn_end without any tts_start before it.
    session = make_session()
    actions = session.on_server_message(
        protocol.parse_server_message('{"type":"turn_end","expectsReply":true}')
    )
    assert sent_types(actions) == ["wake"]
    assert session.state is ListenerState.LISTENING


def test_barge_in_aborts_and_starts_a_new_utterance() -> None:
    session = make_session(barge_in_enabled=True, barge_in_ms=160.0)
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))

    actions = feed(session, chunks=2, wake=0.0, speech=0.9)
    assert sent_types(actions) == ["abort", "wake"]
    assert any(isinstance(action, StopPlayback) for action in actions)
    assert session.state is ListenerState.LISTENING


def test_barge_in_needs_sustained_speech() -> None:
    session = make_session(barge_in_enabled=True, barge_in_ms=400.0)
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))

    # One loud chunk then quiet: a cough, not an interruption.
    session.on_audio_chunk(SILENT_CHUNK, 0.0, 0.9, CHUNK_MS)
    actions = feed(session, chunks=4, wake=0.0, speech=0.0)
    assert sent_types(actions) == []
    assert session.state is ListenerState.SPEAKING


def test_barge_in_is_off_by_default() -> None:
    # On laptop speakers Jarvis's own voice would trip it; see config.py.
    session = make_session()
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))
    assert sent_types(feed(session, chunks=20, wake=0.0, speech=1.0)) == []


def test_a_barge_in_cancels_a_pending_follow_up() -> None:
    session = make_session(barge_in_enabled=True, barge_in_ms=80.0)
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))
    session.on_server_message(
        protocol.parse_server_message('{"type":"turn_end","expectsReply":true}')
    )
    feed(session, chunks=1, wake=0.0, speech=0.9)

    # The interruption already opened a listen; the stale follow-up must not
    # open a second one and send a duplicate `wake`.
    assert sent_types(session.on_playback_finished()) == []
    assert session.state is ListenerState.LISTENING


def test_confirmations_are_never_answered_automatically() -> None:
    session = make_session()
    actions = session.on_server_message(
        protocol.parse_server_message(
            '{"type":"confirm_request","id":"c1","summary":"delete the bucket","expiresAt":1}'
        )
    )
    assert sent_types(actions) == []
    assert any(isinstance(action, PlayEarcon) for action in actions)


def test_playback_acks_accumulate() -> None:
    session = make_session()
    session.on_server_message(
        protocol.parse_server_message('{"type":"tts_start","format":"pcm","sequence":7}')
    )

    first = session.on_audio_played(200)[0].message
    second = session.on_audio_played(300)[0].message
    assert (first["sequence"], first["playedMilliseconds"]) == (7, 200)
    assert (second["sequence"], second["playedMilliseconds"]) == (7, 500)


def test_tts_aborted_stops_playback() -> None:
    session = make_session()
    session.on_server_message(protocol.parse_server_message('{"type":"tts_start","format":"pcm"}'))
    actions = session.on_server_message(protocol.parse_server_message('{"type":"tts_aborted"}'))
    assert any(isinstance(action, StopPlayback) for action in actions)


@pytest.mark.parametrize(
    "overrides",
    [
        {"wake_threshold": 0.0},
        {"wake_threshold": 1.5},
        {"agent_url": "https://example.com"},
        {"end_of_speech_ms": 0.0},
        {"max_utterance_ms": 100.0, "end_of_speech_ms": 700.0},
        {"telemetry_interval_seconds": 0},
    ],
)
def test_invalid_configuration_is_rejected(overrides: dict) -> None:
    with pytest.raises(ValueError):
        ListenerConfig(**overrides).validate()
