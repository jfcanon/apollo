"""The listening state machine, with no audio device and no socket in sight.

Every microphone policy decision lives here: when to wake, when the user has
stopped talking, when to interrupt, and whether to reopen the mic after Jarvis
finishes. The caller feeds it scores and server frames and executes the actions
it returns, which is what makes the replay tests in `tests/test_replay.py`
possible -- they push recorded WAVs through this class and assert on the frames
that come out, with nothing mocked.

The server owns the conversation; this owns the microphone.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from jarvis_listener import protocol
from jarvis_listener.config import ListenerConfig


class ListenerState(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"


@dataclass(frozen=True)
class SendJson:
    message: dict


@dataclass(frozen=True)
class SendAudio:
    pcm_bytes: bytes


@dataclass(frozen=True)
class PlayEarcon:
    name: str


@dataclass(frozen=True)
class BeginPlayback:
    sample_rate_hz: int
    channels: int
    sequence: int


@dataclass(frozen=True)
class StopPlayback:
    pass


@dataclass(frozen=True)
class Note:
    """Something the operator should see in the log; never a protocol frame."""

    event: str
    detail: str = ""


Action = SendJson | SendAudio | PlayEarcon | BeginPlayback | StopPlayback | Note


class ListenerSession:
    def __init__(self, config: ListenerConfig, *, epoch_seconds: int = 0) -> None:
        self._config = config
        self._state = ListenerState.IDLE
        self._now_seconds = epoch_seconds
        self._elapsed_ms = 0.0

        self._silence_ms = 0.0
        self._speech_ms = 0.0
        self._utterance_ms = 0.0
        self._heard_speech = False
        self._wake_blocked_ms = 0.0

        # Audio captured just before the wake fired. People run the wake word
        # and the question together ("hey jarvis what does CI CD mean"), and the
        # detector only fires once the phrase is over, so without this the first
        # word of the question is lost.
        self._preroll: list[bytes] = []
        self._preroll_ms = 0.0

        self._playback_pending = False
        self._follow_up_after_playback: bool | None = None
        self._sequence = 0
        self._played_milliseconds = 0

    @property
    def state(self) -> ListenerState:
        return self._state

    def set_clock(self, epoch_seconds: int) -> None:
        self._now_seconds = epoch_seconds

    def start(self) -> list[Action]:
        return [SendJson(protocol.build_hello(self._now_seconds, self._config.device_id))]

    def on_audio_chunk(
        self, pcm_bytes: bytes, wake_score: float, speech_probability: float, chunk_ms: float
    ) -> list[Action]:
        self._elapsed_ms += chunk_ms
        self._wake_blocked_ms = max(0.0, self._wake_blocked_ms - chunk_ms)
        is_speech = speech_probability >= self._config.speech_probability_threshold

        if self._state is ListenerState.SPEAKING:
            return self._while_speaking(is_speech, chunk_ms)

        if self._state is ListenerState.THINKING:
            # Half duplex: the turn is running and nothing we capture now
            # belongs to it. Keep it as pre-roll so an early follow-up survives.
            self._remember_preroll(pcm_bytes, chunk_ms)
            return []

        if self._state is ListenerState.IDLE:
            self._remember_preroll(pcm_bytes, chunk_ms)
            if self._wake_blocked_ms > 0 or wake_score < self._config.wake_threshold:
                return []
            return self._begin_utterance(reason="wake_word")

        return self._while_listening(pcm_bytes, is_speech, chunk_ms)

    def _while_listening(
        self, pcm_bytes: bytes, is_speech: bool, chunk_ms: float
    ) -> list[Action]:
        actions: list[Action] = [SendAudio(pcm_bytes)]
        self._utterance_ms += chunk_ms

        if is_speech:
            self._heard_speech = True
            self._silence_ms = 0.0
        else:
            self._silence_ms += chunk_ms

        if not self._heard_speech:
            # A wake with no speech behind it is a false accept. Withdraw the
            # listen instead of running a turn on room tone.
            if self._silence_ms >= self._config.no_speech_timeout_ms:
                self._state = ListenerState.IDLE
                self._reset_utterance()
                actions.append(SendJson(protocol.build_listen_cancel(self._now_seconds)))
                actions.append(Note("listen_cancelled", "no speech after wake"))
            return actions

        if self._silence_ms >= self._config.end_of_speech_ms:
            return actions + self._end_utterance("silence")

        if self._utterance_ms >= self._config.max_utterance_ms:
            return actions + self._end_utterance("max_length")

        return actions

    def _while_speaking(self, is_speech: bool, chunk_ms: float) -> list[Action]:
        if not self._config.barge_in_enabled:
            return []

        if not is_speech:
            self._speech_ms = 0.0
            return []

        self._speech_ms += chunk_ms
        if self._speech_ms < self._config.barge_in_ms:
            return []

        # Talking over Jarvis stops him. `abort` first, so the server stops
        # synthesizing before we have even drained what is queued locally.
        self._playback_pending = False
        self._follow_up_after_playback = None
        actions: list[Action] = [
            SendJson(protocol.build_abort(self._now_seconds)),
            StopPlayback(),
            Note("barge_in", f"{self._speech_ms:.0f}ms of speech over playback"),
        ]
        self._state = ListenerState.IDLE
        return actions + self._begin_utterance(reason="barge_in")

    def _begin_utterance(self, *, reason: str) -> list[Action]:
        self._state = ListenerState.LISTENING
        self._reset_utterance()
        self._wake_blocked_ms = self._config.wake_refractory_ms

        actions: list[Action] = [
            Note("listen_open", reason),
            PlayEarcon(self._config.wake_earcon),
            SendJson(protocol.build_wake(self._now_seconds)),
        ]
        # `wake` clears the server's audio buffer, so the pre-roll has to follow
        # it, never precede it.
        actions.extend(SendAudio(chunk) for chunk in self._preroll)
        self._preroll.clear()
        self._preroll_ms = 0.0
        return actions

    def _end_utterance(self, reason: str) -> list[Action]:
        self._state = ListenerState.THINKING
        self._reset_utterance()
        return [
            SendJson(protocol.build_audio_end(self._now_seconds)),
            Note("listen_closed", reason),
        ]

    def _reset_utterance(self) -> None:
        self._silence_ms = 0.0
        self._speech_ms = 0.0
        self._utterance_ms = 0.0
        self._heard_speech = False

    def _remember_preroll(self, pcm_bytes: bytes, chunk_ms: float) -> None:
        if self._config.preroll_ms <= 0:
            return
        self._preroll.append(pcm_bytes)
        self._preroll_ms += chunk_ms
        while self._preroll_ms > self._config.preroll_ms and len(self._preroll) > 1:
            self._preroll.pop(0)
            self._preroll_ms -= chunk_ms

    def on_server_message(self, message: protocol.ServerMessage) -> list[Action]:
        if message.type == "tts_start":
            self._state = ListenerState.SPEAKING
            self._playback_pending = True
            self._speech_ms = 0.0
            self._sequence = message.sequence
            self._played_milliseconds = 0
            return [
                BeginPlayback(
                    sample_rate_hz=message.sample_rate_hz or protocol.DEFAULT_TTS_SAMPLE_RATE_HZ,
                    channels=message.channels or 1,
                    sequence=message.sequence,
                )
            ]

        if message.type == "tts_aborted":
            self._playback_pending = False
            return [StopPlayback()]

        if message.type == "turn_end":
            # Speech is still draining out of the speaker at this point, so the
            # decision is recorded and applied by on_playback_drained().
            self._follow_up_after_playback = message.expects_reply
            if self._playback_pending:
                return [Note("turn_end", f"expectsReply={message.expects_reply}")]
            return self._apply_follow_up()

        if message.type == "play_effect":
            return [PlayEarcon(message.effect_name or "ding")]

        if message.type == "confirm_request":
            # Deliberately unanswered: a confirmation gates a tool side effect,
            # and a daemon with no screen has no way to know the owner agreed.
            # It expires, or it gets answered from /console on the same session.
            return [
                PlayEarcon("chime"),
                Note("confirm_request_ignored", message.summary or ""),
            ]

        if message.type == "error":
            return [Note("server_error", f"{message.code}: {message.message}")]

        if message.type == "ui_state":
            return [Note("ui_state", message.state or "")]

        return []

    def on_playback_finished(self) -> list[Action]:
        """Called when the output stream has drained everything it was handed."""
        self._playback_pending = False
        if self._follow_up_after_playback is None:
            return []
        return self._apply_follow_up()

    def _apply_follow_up(self) -> list[Action]:
        expects_reply = bool(self._follow_up_after_playback)
        self._follow_up_after_playback = None

        if not expects_reply:
            self._state = ListenerState.IDLE
            self._preroll.clear()
            self._preroll_ms = 0.0
            return [Note("idle", "waiting for the wake word")]

        # Jarvis asked something. Reopening the mic without making the owner say
        # "hey jarvis" again is the whole difference between an interview and a
        # conversation.
        self._state = ListenerState.IDLE
        self._preroll.clear()
        self._preroll_ms = 0.0
        return self._begin_utterance(reason="expects_reply")

    def on_audio_played(self, milliseconds: int) -> list[Action]:
        """Playback acks close the server's pacing loop; see voice/stream.ts."""
        self._played_milliseconds += milliseconds
        return [
            SendJson(
                protocol.build_playback_ack(
                    self._now_seconds, self._sequence, self._played_milliseconds
                )
            )
        ]
