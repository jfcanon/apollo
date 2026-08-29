"""Push three WAVs through the real wake word, the real VAD and the real state
machine, and assert on the protocol frames that come out.

Nothing is mocked except the socket and the speaker, so a regression in the
model wiring, the VAD frame size or the microphone policy fails here. This is
the closest thing to the demo that can run unattended.

The clips are synthesized by `spike/corpus.py --fixtures` rather than recorded
from a human, because CI has no microphone and the daemon's own host may not
have granted mic permission. Regenerate them with:

    python spike/corpus.py --fixtures tests/fixtures
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from jarvis_listener import protocol
from jarvis_listener.config import ListenerConfig
from jarvis_listener.session import ListenerSession, ListenerState, SendAudio, SendJson

FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"
CHUNK_SAMPLES = 1280
CHUNK_MS = CHUNK_SAMPLES / protocol.MIC_SAMPLE_RATE_HZ * 1000

pytestmark = pytest.mark.audio


@pytest.fixture(scope="module")
def detectors():
    onnxruntime = pytest.importorskip("onnxruntime", reason="wake-word models need onnxruntime")
    assert onnxruntime is not None

    from jarvis_listener.vad import SpeechDetector
    from jarvis_listener.wake import WakeWordDetector

    return WakeWordDetector(), SpeechDetector()


def read_chunks(name: str):
    with wave.open(str(FIXTURE_DIRECTORY / f"{name}.wav")) as handle:
        assert handle.getframerate() == protocol.MIC_SAMPLE_RATE_HZ
        assert handle.getnchannels() == 1
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)
    for start in range(0, len(samples) - CHUNK_SAMPLES, CHUNK_SAMPLES):
        yield samples[start : start + CHUNK_SAMPLES]


def replay(detectors, name: str, session: ListenerSession) -> list:
    wake_detector, speech_detector = detectors
    wake_detector.reset()
    speech_detector.reset()

    actions = []
    for chunk in read_chunks(name):
        actions.extend(
            session.on_audio_chunk(
                chunk.tobytes(),
                wake_detector.score(chunk),
                speech_detector.speech_probability(chunk),
                CHUNK_MS,
            )
        )
    return actions


def make_session(**overrides) -> ListenerSession:
    config = ListenerConfig(**overrides)
    config.validate()
    return ListenerSession(config, epoch_seconds=1_756_400_000)


def sent_types(actions) -> list[str]:
    return [action.message["type"] for action in actions if isinstance(action, SendJson)]


def test_wake_clip_runs_a_whole_turn(detectors) -> None:
    session = make_session()
    actions = replay(detectors, "wake", session)

    # "hey jarvis what does CI CD mean" -- one wake, then the question, then
    # the VAD closing it on the trailing room tone.
    assert sent_types(actions) == ["wake", "audio_end"]
    assert session.state is ListenerState.THINKING


def test_wake_clip_uploads_the_question_audio(detectors) -> None:
    session = make_session()
    actions = replay(detectors, "wake", session)

    uploaded_bytes = sum(
        len(action.pcm_bytes) for action in actions if isinstance(action, SendAudio)
    )
    uploaded_ms = uploaded_bytes / 2 / protocol.MIC_SAMPLE_RATE_HZ * 1000
    # The question is roughly 1.5 s; anything under half a second means the
    # wake fired late and swallowed the front of it.
    assert uploaded_ms > 500


def test_wake_is_sent_before_any_audio(detectors) -> None:
    session = make_session()
    actions = replay(detectors, "wake", session)

    protocol_actions = [
        action for action in actions if isinstance(action, (SendJson, SendAudio))
    ]
    # `wake` resets the server's audio buffer, so audio ahead of it is dropped.
    assert isinstance(protocol_actions[0], SendJson)
    assert protocol_actions[0].message["type"] == "wake"


def test_conversation_clip_never_wakes(detectors) -> None:
    session = make_session()
    actions = replay(detectors, "no_wake", session)

    assert sent_types(actions) == []
    assert not any(isinstance(action, SendAudio) for action in actions)
    assert session.state is ListenerState.IDLE


def test_barge_in_clip_interrupts_playback(detectors) -> None:
    session = make_session(barge_in_enabled=True)
    session.on_server_message(
        protocol.parse_server_message('{"type":"tts_start","format":"pcm","sampleRate":24000}')
    )
    assert session.state is ListenerState.SPEAKING

    actions = replay(detectors, "barge_in", session)

    # Interrupting is not just silencing him: the words spoken over him become
    # the next turn, so the abort is immediately followed by a fresh listen and
    # the interrupting sentence is uploaded and submitted.
    assert sent_types(actions) == ["abort", "wake", "audio_end"]
    assert session.state is ListenerState.THINKING
    assert any(isinstance(action, SendAudio) for action in actions)


def test_barge_in_uploads_only_what_was_said_over_him(detectors) -> None:
    session = make_session(barge_in_enabled=True)
    session.on_server_message(
        protocol.parse_server_message('{"type":"tts_start","format":"pcm","sampleRate":24000}')
    )
    actions = replay(detectors, "barge_in", session)

    abort_index = next(
        index
        for index, action in enumerate(actions)
        if isinstance(action, SendJson) and action.message["type"] == "abort"
    )
    # Half duplex: nothing captured while he was still speaking may be uploaded,
    # or his own voice ends up in the transcript of the interruption.
    assert not any(isinstance(action, SendAudio) for action in actions[:abort_index])


def test_barge_in_clip_is_ignored_when_barge_in_is_off(detectors) -> None:
    session = make_session(barge_in_enabled=False)
    session.on_server_message(
        protocol.parse_server_message('{"type":"tts_start","format":"pcm","sampleRate":24000}')
    )

    assert sent_types(replay(detectors, "barge_in", session)) == []
    assert session.state is ListenerState.SPEAKING


def test_the_vad_does_not_cut_the_question_short(detectors) -> None:
    """The 30 ms frame regression guard.

    With Silero fed 20 ms frames instead of its native 30, this clip ends its
    turn in the middle of the question -- the spike measured up to 2.1 s cut off.
    Uploading the whole question is what proves the frame size is still right.
    """
    session = make_session()
    actions = replay(detectors, "wake", session)

    audio_end_index = next(
        index
        for index, action in enumerate(actions)
        if isinstance(action, SendJson) and action.message["type"] == "audio_end"
    )
    uploaded_ms = (
        sum(
            len(action.pcm_bytes)
            for action in actions[:audio_end_index]
            if isinstance(action, SendAudio)
        )
        / 2
        / protocol.MIC_SAMPLE_RATE_HZ
        * 1000
    )
    # Question plus the 700 ms hangover; a truncated turn lands far below this.
    assert uploaded_ms > 1500
