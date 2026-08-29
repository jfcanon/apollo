"""The daemon: one outbound WebSocket to Apollo, reconnected forever.

Same shape as `apps/bridge/index.ts` -- outbound only, token from the Keychain,
exponential backoff, no inbound listener anywhere. The state machine in
session.py decides what to send; this module owns the socket, the audio devices
and the clock, and does nothing else.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import subprocess
import time

import numpy as np
import websockets

from jarvis_listener import earcon, protocol
from jarvis_listener.audio import MicrophoneCapture, SpeakerPlayback, resolve_device
from jarvis_listener.config import ListenerConfig
from jarvis_listener.keychain import build_connection_url, read_device_secret, redact_url
from jarvis_listener.session import (
    Action,
    BeginPlayback,
    ListenerSession,
    Note,
    PlayEarcon,
    SendAudio,
    SendJson,
    StopPlayback,
)
from jarvis_listener.vad import SpeechDetector
from jarvis_listener.wake import WakeWordDetector

logger = logging.getLogger("jarvis.listener")

PLAYBACK_POLL_SECONDS = 0.2


def read_battery() -> tuple[int | None, bool | None]:
    """Battery percent and charging flag from `pmset`; both None on a desktop."""
    try:
        completed = subprocess.run(
            ["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, None

    percent: int | None = None
    for token in completed.stdout.replace(";", " ").split():
        if token.endswith("%"):
            with contextlib.suppress(ValueError):
                percent = int(token.rstrip("%"))
            break
    if percent is None:
        return None, None
    return percent, "AC Power" in completed.stdout


class ListenerClient:
    def __init__(self, config: ListenerConfig) -> None:
        self._config = config
        self._session = ListenerSession(config, epoch_seconds=int(time.time()))
        self._earcons = earcon.build_catalog(config.earcon_volume)

        self._wake = WakeWordDetector()
        self._speech = SpeechDetector()

        self._microphone = MicrophoneCapture(
            resolve_device(config.input_device, want_input=True)
        )
        self._speaker = SpeakerPlayback(resolve_device(config.output_device, want_input=False))
        self._socket: websockets.ClientConnection | None = None

    async def run_forever(self) -> None:
        token = read_device_secret(self._config.keychain_service, self._config.keychain_account)
        url = build_connection_url(self._config.agent_url, token)
        logger.info("connecting to %s", redact_url(url))

        delay_seconds = self._config.reconnect_min_seconds
        self._microphone.start()
        try:
            while True:
                try:
                    await self._connect_once(url)
                    delay_seconds = self._config.reconnect_min_seconds
                except (OSError, websockets.WebSocketException) as error:
                    logger.warning("connection lost: %s", error)
                except Exception:
                    logger.exception("listener loop crashed; reconnecting")

                self._speaker.stop()
                logger.info("reconnecting in %.0fs", delay_seconds)
                await asyncio.sleep(delay_seconds)
                delay_seconds = min(delay_seconds * 2, self._config.reconnect_max_seconds)
        finally:
            self._microphone.stop()
            self._speaker.stop()

    async def _connect_once(self, url: str) -> None:
        async with websockets.connect(url, max_size=None) as socket:
            self._socket = socket
            logger.info("connected; say \"hey jarvis\"")

            # A fresh socket means a fresh turn: stale feature buffers would let
            # audio from before the drop leak into the first utterance after it.
            self._wake.reset()
            self._speech.reset()
            self._session = ListenerSession(self._config, epoch_seconds=int(time.time()))
            await self._execute(self._session.start())

            tasks = [
                asyncio.create_task(self._pump_microphone(), name="microphone"),
                asyncio.create_task(self._pump_socket(socket), name="socket"),
                asyncio.create_task(self._pump_playback(), name="playback"),
                asyncio.create_task(self._pump_telemetry(), name="telemetry"),
            ]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                self._socket = None

    async def _pump_microphone(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            chunk = await loop.run_in_executor(None, self._microphone.read, 1.0)
            if chunk is None:
                continue

            self._session.set_clock(int(time.time()))
            chunk_ms = len(chunk) / protocol.MIC_SAMPLE_RATE_HZ * 1000
            wake_score = self._wake.score(chunk)
            speech_probability = self._speech.speech_probability(chunk)

            await self._execute(
                self._session.on_audio_chunk(
                    chunk.tobytes(), wake_score, speech_probability, chunk_ms
                )
            )

    async def _pump_socket(self, socket: websockets.ClientConnection) -> None:
        async for raw in socket:
            if isinstance(raw, bytes):
                self._speaker.enqueue(raw)
                continue
            try:
                message = protocol.parse_server_message(raw)
            except protocol.ProtocolError as error:
                logger.warning("dropping malformed frame: %s", error)
                continue
            if message is None:
                continue
            self._session.set_clock(int(time.time()))
            await self._execute(self._session.on_server_message(message))

    async def _pump_playback(self) -> None:
        """Ack what the speaker has actually played, and notice when it drains."""
        was_draining = False
        while True:
            await asyncio.sleep(PLAYBACK_POLL_SECONDS)
            self._session.set_clock(int(time.time()))

            played_milliseconds = self._speaker.take_played_milliseconds()
            if played_milliseconds > 0:
                await self._execute(self._session.on_audio_played(played_milliseconds))

            is_draining = self._speaker.is_draining
            if was_draining and not is_draining:
                await self._execute(self._session.on_playback_finished())
            was_draining = is_draining

    async def _pump_telemetry(self) -> None:
        while True:
            battery_percent, is_charging = read_battery()
            self._session.set_clock(int(time.time()))
            await self._send_json(
                protocol.build_telemetry(
                    int(time.time()),
                    battery_percent=battery_percent,
                    is_charging=is_charging,
                    firmware_version=self._config.device_id,
                )
            )
            await asyncio.sleep(self._config.telemetry_interval_seconds)

    async def _execute(self, actions: list[Action]) -> None:
        for action in actions:
            if isinstance(action, SendJson):
                await self._send_json(action.message)
            elif isinstance(action, SendAudio):
                if self._socket is not None:
                    await self._socket.send(action.pcm_bytes)
            elif isinstance(action, PlayEarcon):
                self._play_earcon(action.name)
            elif isinstance(action, BeginPlayback):
                self._speaker.begin(action.sample_rate_hz, action.channels)
            elif isinstance(action, StopPlayback):
                self._speaker.flush()
            elif isinstance(action, Note):
                logger.info("%s %s", action.event, action.detail)

    async def _send_json(self, message: dict) -> None:
        if self._socket is None:
            return
        await self._socket.send(protocol.encode(message))

    def _play_earcon(self, name: str) -> None:
        pcm_bytes = self._earcons.get(name)
        if pcm_bytes is None:
            logger.info("unknown effect %s; ignored", name)
            return
        # Earcons are 24 kHz mono, the same format the TTS arrives in, so they
        # can share the output stream instead of fighting it for the device.
        self._speaker.begin(earcon.EARCON_SAMPLE_RATE_HZ, 1)
        self._speaker.enqueue(pcm_bytes)


def describe_devices() -> str:
    from jarvis_listener.audio import list_devices

    lines = []
    for device in list_devices():
        roles = []
        if device.input_channels > 0:
            roles.append(f"in:{device.input_channels}")
        if device.output_channels > 0:
            roles.append(f"out:{device.output_channels}")
        lines.append(f"  [{device.index}] {device.name} ({', '.join(roles)})")
    return "\n".join(lines)


def selftest(config: ListenerConfig) -> int:
    """Prove the parts work without opening a socket: models, devices, secret."""
    report: dict[str, str] = {}
    try:
        WakeWordDetector()
        report["wake_word"] = "ok"
    except Exception as error:
        report["wake_word"] = f"FAILED: {error}"

    try:
        SpeechDetector().speech_probability(np.zeros(1280, dtype=np.int16))
        report["vad"] = "ok"
    except Exception as error:
        report["vad"] = f"FAILED: {error}"

    try:
        resolve_device(config.input_device, want_input=True)
        resolve_device(config.output_device, want_input=False)
        report["audio_devices"] = "ok"
    except Exception as error:
        report["audio_devices"] = f"FAILED: {error}"

    try:
        read_device_secret(config.keychain_service, config.keychain_account)
        report["keychain"] = "ok"  # never print the secret itself
    except Exception as error:
        report["keychain"] = f"FAILED: {error}"

    print(json.dumps(report, indent=2))
    return 0 if all(value == "ok" for value in report.values()) else 1
