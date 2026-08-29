"""Microphone capture and speaker playback via PortAudio (sounddevice).

Audio only ever exists in memory here: captured chunks go to the socket and are
dropped, played chunks go to the device and are dropped. Nothing is written to
disk at any point, which is the reason there is no debug-recording option.

`sounddevice` is imported lazily so the protocol and session tests -- the ones
CI runs -- need neither PortAudio nor an audio device.
"""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass

import numpy as np

from jarvis_listener.protocol import MIC_SAMPLE_RATE_HZ

CAPTURE_CHUNK_SAMPLES = 1280  # 80 ms, openWakeWord's native step


@dataclass(frozen=True)
class AudioDevice:
    index: int
    name: str
    input_channels: int
    output_channels: int


def list_devices() -> list[AudioDevice]:
    import sounddevice

    return [
        AudioDevice(
            index=index,
            name=str(entry["name"]),
            input_channels=int(entry["max_input_channels"]),
            output_channels=int(entry["max_output_channels"]),
        )
        for index, entry in enumerate(sounddevice.query_devices())
    ]


def resolve_device(name_fragment: str | None, *, want_input: bool) -> int | None:
    """Match a device by case-insensitive substring, so "AirPods" is enough."""
    if not name_fragment:
        return None
    needle = name_fragment.casefold()
    for device in list_devices():
        channels = device.input_channels if want_input else device.output_channels
        if channels > 0 and needle in device.name.casefold():
            return device.index
    direction = "input" if want_input else "output"
    available = ", ".join(
        device.name
        for device in list_devices()
        if (device.input_channels if want_input else device.output_channels) > 0
    )
    raise ValueError(f"no {direction} device matching {name_fragment!r}. Available: {available}")


class MicrophoneCapture:
    """A 16 kHz mono PCM16 stream, delivered in 80 ms chunks."""

    def __init__(self, device_index: int | None = None, *, queue_depth: int = 64) -> None:
        self._device_index = device_index
        self._chunks: queue.Queue[np.ndarray] = queue.Queue(maxsize=queue_depth)
        self._stream = None
        self.dropped_chunks = 0

    def start(self) -> None:
        import sounddevice

        def on_audio(indata, _frames, _time, status) -> None:
            if status:  # overflow/underflow; the chunk is still usable
                pass
            try:
                self._chunks.put_nowait(indata[:, 0].copy())
            except queue.Full:
                # Better to lose the oldest audio than to block PortAudio's
                # callback thread, which would glitch the whole stream.
                self.dropped_chunks += 1

        self._stream = sounddevice.InputStream(
            samplerate=MIC_SAMPLE_RATE_HZ,
            blocksize=CAPTURE_CHUNK_SAMPLES,
            device=self._device_index,
            channels=1,
            dtype="int16",
            callback=on_audio,
        )
        self._stream.start()

    def read(self, timeout: float = 1.0) -> np.ndarray | None:
        try:
            return self._chunks.get(timeout=timeout)
        except queue.Empty:
            return None

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


class SpeakerPlayback:
    """Queued PCM16 playback that reports how much audio it has actually played.

    The played-milliseconds count is what `playback_ack` carries, and the server
    paces its TTS stream against it, so it has to track the device clock rather
    than how much we have received.
    """

    def __init__(self, device_index: int | None = None) -> None:
        self._device_index = device_index
        self._stream = None
        self._sample_rate_hz = 0
        self._channels = 1
        self._pending: queue.Queue[np.ndarray] = queue.Queue()
        self._leftover = np.zeros(0, dtype=np.int16)
        self._lock = threading.Lock()
        self._played_samples = 0
        self._acked_samples = 0

    def begin(self, sample_rate_hz: int, channels: int) -> None:
        import sounddevice

        if self._stream is not None and (
            self._sample_rate_hz == sample_rate_hz and self._channels == channels
        ):
            return

        self.stop()
        self._sample_rate_hz = sample_rate_hz
        self._channels = channels

        def on_output(outdata, frames, _time, _status) -> None:
            needed = frames * self._channels
            block = self._leftover
            while len(block) < needed:
                try:
                    block = np.concatenate([block, self._pending.get_nowait()])
                except queue.Empty:
                    break
            if len(block) < needed:
                outdata[:] = 0
                if len(block) > 0:
                    outdata.reshape(-1)[: len(block)] = block
                    with self._lock:
                        self._played_samples += len(block)
                self._leftover = np.zeros(0, dtype=np.int16)
                return
            outdata.reshape(-1)[:] = block[:needed]
            self._leftover = block[needed:]
            with self._lock:
                self._played_samples += needed

        self._stream = sounddevice.OutputStream(
            samplerate=sample_rate_hz,
            device=self._device_index,
            channels=channels,
            dtype="int16",
            callback=on_output,
        )
        self._stream.start()

    def enqueue(self, pcm_bytes: bytes) -> None:
        if self._stream is None:
            return
        self._pending.put(np.frombuffer(pcm_bytes, dtype=np.int16))

    def take_played_milliseconds(self) -> int:
        """Milliseconds played since the last call; 0 when nothing new landed."""
        if self._sample_rate_hz == 0:
            return 0
        with self._lock:
            fresh = self._played_samples - self._acked_samples
            self._acked_samples = self._played_samples
        return int(fresh / self._channels / self._sample_rate_hz * 1000)

    @property
    def is_draining(self) -> bool:
        return not self._pending.empty() or len(self._leftover) > 0

    def flush(self) -> None:
        """Drop everything queued; barge-in has to be audible immediately."""
        while True:
            try:
                self._pending.get_nowait()
            except queue.Empty:
                break
        self._leftover = np.zeros(0, dtype=np.int16)

    def stop(self) -> None:
        self.flush()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        self._sample_rate_hz = 0
        with self._lock:
            self._played_samples = 0
            self._acked_samples = 0
