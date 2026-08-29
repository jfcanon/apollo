// The phone console page, served as one self-contained HTML string.
//
// It speaks the SAME device protocol the ESP32 speaks (see
// @/protocol/schema): `hello`, then `wake` + binary PCM16 frames +
// `audio_end` to talk, and `tts_start` / binary run / `tts_end` / `turn_end`
// coming back. Nothing server-side is phone-specific, so the phone gets every
// tool, memory and confirmation the desk box has, for free.
//
// Dialogue rather than interview: the mic reopens by itself after Jarvis
// finishes, and speaking over him aborts his reply. That loop lives here, in
// the client, because it is a microphone policy — the turn engine already
// supports it.

const MIC_SAMPLE_RATE_HZ = 16000; // must match DEVICE_MIC_PCM_SAMPLE_RATE_HZ
const TTS_SAMPLE_RATE_HZ = 24000; // what the TTS providers emit

export function buildConsolePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black" />
<title>Jarvis</title>
<style>
  :root { color-scheme: dark; --amber: #ffb347; --dim: #5a4630; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; min-height: 100dvh; background: #000; color: var(--amber);
    font: 16px/1.5 ui-rounded, -apple-system, system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  }
  header { width: 100%; display: flex; justify-content: space-between; align-items: center; font-size: 13px; opacity: .75; }
  #orb {
    width: min(58vw, 260px); aspect-ratio: 1; border-radius: 50%;
    border: 2px solid var(--dim); display: grid; place-items: center;
    transition: box-shadow .25s, border-color .25s, transform .25s;
  }
  #orb.listening { border-color: var(--amber); box-shadow: 0 0 46px rgba(255,179,71,.34); }
  #orb.thinking  { border-color: var(--dim);  box-shadow: 0 0 26px rgba(255,179,71,.16); }
  #orb.speaking  { border-color: var(--amber); box-shadow: 0 0 60px rgba(255,179,71,.5); transform: scale(1.03); }
  #level { width: 46%; aspect-ratio: 1; border-radius: 50%; background: var(--amber); opacity: .18; transition: transform .08s linear; }
  #caption { min-height: 4.5em; width: 100%; max-width: 34rem; text-align: center; font-size: 18px; }
  footer { width: 100%; max-width: 34rem; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  button {
    font: inherit; color: var(--amber); background: #000; border: 2px solid var(--amber);
    border-radius: 999px; padding: 14px 26px; min-width: 12rem;
  }
  button.secondary { border-color: var(--dim); min-width: 0; padding: 9px 16px; font-size: 14px; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  label.toggle { display: flex; gap: 8px; align-items: center; font-size: 14px; opacity: .8; }
  select.device-select { font: inherit; background: #000; color: var(--amber); border: 2px solid var(--dim); border-radius: 10px; padding: 8px 12px; width: 100%; max-width: 24rem; }
  .device-row { display: flex; gap: 10px; align-items: center; width: 100%; max-width: 34rem; justify-content: center; flex-wrap: wrap; }
  .device-row > label { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; opacity: .8; }
  #confirm { position: fixed; inset: 0; background: rgba(0,0,0,.94); display: none; flex-direction: column;
             gap: 18px; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  #confirm.open { display: flex; }
  input[type=password] { font: inherit; background: #000; color: var(--amber); border: 2px solid var(--dim);
                           border-radius: 10px; padding: 10px 12px; width: 100%; max-width: 24rem; }
  .hint { font-size: 12px; opacity: .6; text-align: center; width: 100%; max-width: 34rem; }
</style>
</head>
<body>
<header><span id="status">disconnected</span><span id="mode"></span></header>

<div id="orb"><div id="level"></div></div>
<div id="caption"></div>

<footer>
  <button id="primary">Connect</button>
  <div class="row">
    <button class="secondary" id="talk">Talk</button>
    <button class="secondary" id="stop">Stop</button>
  </div>
  <div class="device-row">
    <label>Input<select class="device-select" id="inputDevice"></select></label>
    <label id="outputLabel">Output<select class="device-select" id="outputDevice"></select></label>
  </div>
  <label class="toggle"><input type="checkbox" id="dialogue" checked /> Open dialogue</label>
  <label class="toggle"><input type="checkbox" id="headphones" /> Headphones (barge-in while speaking)</label>
</footer>

<div id="confirm">
  <div id="confirmText"></div>
  <div class="row">
    <button id="confirmYes">Yes</button>
    <button class="secondary" id="confirmNo">No</button>
  </div>
</div>

<div class="hint" id="hint">Hold Space to talk · Esc to abort</div>

<script type="module">
const MIC_RATE = ${MIC_SAMPLE_RATE_HZ};
const TTS_RATE = ${TTS_SAMPLE_RATE_HZ};

// --- Voice activity detection tuning -------------------------------------
// Deliberately conservative: a false start costs a whole wasted turn, while a
// slightly late start costs nothing the user notices.
const SPEECH_RMS_ON = 0.030;       // enter speech
const SPEECH_RMS_OFF = 0.018;      // leave speech (hysteresis, avoids chatter)
const MIN_SPEECH_MS = 260;         // ignore coughs, door clicks, taps
const TRAILING_SILENCE_MS = 700;   // end of utterance
const BARGE_IN_MS = 380;           // sustained speech needed to cut Jarvis off

const els = Object.fromEntries(['status','mode','orb','level','caption','primary','talk','stop',
  'dialogue','headphones','confirm','confirmText','confirmYes','confirmNo',
  'inputDevice','outputDevice','outputLabel','hint'
  ].map((id) => [id, document.getElementById(id)]));

const state = {
  socket: null, audioContext: null, micStream: null, workletNode: null,
  capturing: false, speaking: false, uiState: 'idle',
  speechMs: 0, silenceMs: 0, inUtterance: false,
  playQueue: [], playHead: 0, nextPlayTime: 0, sequence: 0, playedMs: 0,
  pendingConfirmId: null, closedByUser: false,
  selectedInputDeviceId: null, selectedOutputDeviceId: null,
  spaceHeld: false,
  workletModuleLoaded: false,
  inputChangeHandler: null,
  outputChangeHandler: null,
};

const setStatus = (text) => { els.status.textContent = text; };
const setCaption = (text) => { els.caption.textContent = text ?? ''; };
function setOrb(kind) {
  els.orb.className = kind;
  els.mode.textContent = kind === 'listening' ? 'listening'
    : kind === 'speaking' ? 'speaking' : kind === 'thinking' ? 'thinking' : '';
}

// --- Device persistence ---------------------------------------------------
function loadDevicePreferences() {
  const inputId = localStorage.getItem('jarvis.inputDeviceId');
  const outputId = localStorage.getItem('jarvis.outputDeviceId');
  if (inputId) state.selectedInputDeviceId = inputId;
  if (outputId) state.selectedOutputDeviceId = outputId;
}

function saveDevicePreferences() {
  if (state.selectedInputDeviceId) localStorage.setItem('jarvis.inputDeviceId', state.selectedInputDeviceId);
  if (state.selectedOutputDeviceId) localStorage.setItem('jarvis.outputDeviceId', state.selectedOutputDeviceId);
}

function buildOptions(selectEl, devices, selectedId, isInput) {
  selectEl.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = isInput ? 'Default microphone' : 'Default speaker';
  placeholder.disabled = false;
  selectEl.appendChild(placeholder);
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || (isInput ? 'Microphone' : 'Speaker') + ' ' + device.deviceId.slice(0, 8);
    if (device.deviceId === selectedId) option.selected = true;
    selectEl.appendChild(option);
  }
}

async function populateDeviceSelects() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((d) => d.kind === 'audioinput');
  const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

  buildOptions(els.inputDevice, audioInputs, state.selectedInputDeviceId, true);

  // Hide output selector if setSinkId is not supported (e.g., Safari)
  const hasSetSinkId = typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function';
  if (hasSetSinkId) {
    buildOptions(els.outputDevice, audioOutputs, state.selectedOutputDeviceId, false);
    els.outputLabel.style.display = 'flex';
  } else {
    els.outputLabel.style.display = 'none';
  }
}

async function restartCaptureWithNewDevice() {
  if (!state.capturing) return;
  try {
    stopCapture();
    await startCapture();
    if (els.dialogue.checked) armListening();
  } catch (err) {
    console.error('Failed to restart capture with new device:', err);
    setCaption('Failed to switch microphone');
  }
}

// --- Transport ------------------------------------------------------------
function deviceToken() {
  let token = localStorage.getItem('jarvis.deviceToken');
  if (!token) {
    token = prompt('Device token (DEVICE_SHARED_SECRET)') ?? '';
    if (token) localStorage.setItem('jarvis.deviceToken', token);
  }
  return token;
}

function send(message) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ ...message, ts: Math.floor(Date.now() / 1000) }));
  }
}

function connect() {
  const token = deviceToken();
  if (!token) return;
  const url = new URL('/agents/apollo/desk', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);

  const socket = new WebSocket(url.toString());
  socket.binaryType = 'arraybuffer';
  state.socket = socket;
  setStatus('connecting…');

  socket.addEventListener('open', () => {
    setStatus('connected');
    send({ type: 'hello', deviceId: 'mac-console' });
    els.primary.textContent = 'Disconnect';
  });
  socket.addEventListener('close', () => {
    setStatus('disconnected');
    els.primary.textContent = 'Connect';
    stopCapture();
    // Reconnect unless the user asked to stop: phones drop sockets constantly
    // when the screen dims, and a dead page that looks alive is worse.
    if (!state.closedByUser) setTimeout(connect, 1500);
  });
  socket.addEventListener('error', () => setStatus('connection error'));
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') { onAudioChunk(event.data); return; }
    let frame; try { frame = JSON.parse(event.data); } catch { return; }
    onServerFrame(frame);
  });
}

function onServerFrame(frame) {
  switch (frame.type) {
    case 'ui_state':
      state.uiState = frame.state;
      if (frame.caption) setCaption(frame.caption);
      // Orb driven by ui_state; status only for transport state
      if (!state.speaking) {
        if (frame.state === 'listening') { setOrb('listening'); }
        else if (frame.state === 'thinking') { setOrb('thinking'); }
        else if (frame.state === 'speaking') { setOrb('speaking'); }
        else if (frame.state === 'idle') { setOrb('idle'); }
        else if (frame.state === 'confirm') { setOrb('idle'); }
      }
      break;
    case 'tts_start':
      state.speaking = true; state.sequence = frame.sequence ?? 0;
      state.playedMs = 0; state.playQueue = []; state.nextPlayTime = 0;
      setOrb('speaking');
      break;
    case 'tts_end':
    case 'tts_aborted':
      state.speaking = false;
      break;
    case 'turn_end':
      state.speaking = false;
      // The whole point of dialogue mode: reopen the mic without being asked.
      // expectsReply only says Jarvis asked something — in a conversation the
      // user may answer anything, so dialogue mode reopens regardless.
      if (els.dialogue.checked) { armListening(); setOrb('listening'); }
      else { setOrb('idle'); }
      break;
    case 'confirm_request':
      state.pendingConfirmId = frame.id;
      els.confirmText.textContent = frame.summary;
      els.confirm.classList.add('open');
      break;
    case 'confirm_close':
      state.pendingConfirmId = null;
      els.confirm.classList.remove('open');
      break;
    case 'error':
      setCaption('Error: ' + (frame.message ?? 'unknown'));
      break;
    default:
      break;
  }
}

// --- Playback -------------------------------------------------------------
// Chunks are scheduled back to back on the AudioContext clock rather than
// played on arrival: gaps between 8 KB frames are audible as clicks otherwise.
function onAudioChunk(arrayBuffer) {
  const context = state.audioContext;
  if (!context) return;
  const pcm = new Int16Array(arrayBuffer);
  const audioBuffer = context.createBuffer(1, pcm.length, TTS_RATE);
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 32768;

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  const startAt = Math.max(context.currentTime + 0.02, state.nextPlayTime);
  source.start(startAt);
  state.nextPlayTime = startAt + audioBuffer.duration;
  state.playQueue.push(source);

  // Playback acks close the server's pacing loop (see the TTS stream pacer).
  state.playedMs += Math.round(audioBuffer.duration * 1000);
  send({ type: 'playback_ack', sequence: state.sequence, playedMilliseconds: state.playedMs });
}

function stopPlayback() {
  for (const source of state.playQueue) { try { source.stop(); } catch {} }
  state.playQueue = []; state.nextPlayTime = 0; state.speaking = false;
}

// --- Capture --------------------------------------------------------------
// The worklet downsamples 48 kHz float to 16 kHz PCM16 in the audio thread and
// posts both the frame and its RMS, so the main thread never touches raw audio.
const WORKLET_SOURCE = \`
class MicWorklet extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; this.ratio = sampleRate / ${MIC_SAMPLE_RATE_HZ}; this.position = 0; }
  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    let sumSquares = 0;
    for (let i = 0; i < input.length; i += 1) sumSquares += input[i] * input[i];
    const rms = Math.sqrt(sumSquares / input.length);
    // Linear decimation is enough for speech at 48k->16k; the STT models are
    // far more tolerant than the bandwidth we would spend on a proper filter.
    while (this.position < input.length) {
      const index = Math.floor(this.position);
      const sample = Math.max(-1, Math.min(1, input[index]));
      this.buffer.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
      this.position += this.ratio;
    }
    this.position -= input.length;
    if (this.buffer.length >= 512) {
      const frame = Int16Array.from(this.buffer.splice(0, this.buffer.length));
      this.port.postMessage({ frame, rms }, [frame.buffer]);
    } else {
      this.port.postMessage({ rms });
    }
    return true;
  }
}
registerProcessor('mic-worklet', MicWorklet);
\`;

async function startCapture() {
  if (state.capturing) return;
  const context = state.audioContext;
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      ...(state.selectedInputDeviceId ? { deviceId: { exact: state.selectedInputDeviceId } } : {}),
    },
  };
  state.micStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (!state.workletModuleLoaded) {
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    state.workletModuleLoaded = true;
  }

  const source = context.createMediaStreamSource(state.micStream);
  const node = new AudioWorkletNode(context, 'mic-worklet');
  node.port.onmessage = (event) => onMicFrame(event.data);
  source.connect(node);
  // Connected to a muted gain so the graph runs without echoing the mic.
  const silence = context.createGain(); silence.gain.value = 0;
  node.connect(silence).connect(context.destination);
  state.workletNode = node;
  state.capturing = true;

  // Set output device if selected and supported
  if (state.selectedOutputDeviceId && context.setSinkId) {
    await context.setSinkId(state.selectedOutputDeviceId).catch(() => {});
  }
}

function stopCapture() {
  state.capturing = false; state.inUtterance = false;
  if (state.workletNode) { state.workletNode.port.onmessage = null; state.workletNode.disconnect(); state.workletNode = null; }
  if (state.micStream) { for (const track of state.micStream.getTracks()) track.stop(); state.micStream = null; }
}

let listeningArmed = false;
function armListening() { listeningArmed = true; state.speechMs = 0; state.silenceMs = 0; setOrb('listening'); }
function disarmListening() { listeningArmed = false; }

function beginUtterance() {
  state.inUtterance = true;
  send({ type: 'wake' });
  setOrb('listening');
}

function endUtterance() {
  state.inUtterance = false;
  disarmListening();
  send({ type: 'audio_end' });
  setOrb('thinking');
}

const FRAME_MS = 128 / (${MIC_SAMPLE_RATE_HZ} / 1000); // worklet posts ~512 samples

function onMicFrame({ frame, rms }) {
  els.level.style.transform = 'scale(' + (1 + Math.min(rms * 6, 1.1)).toFixed(3) + ')';

  // Barge-in: speaking over Jarvis stops him. Only with headphones on, because
  // on a speakerphone his own voice would trip it constantly.
  if (state.speaking) {
    if (els.headphones.checked && rms > SPEECH_RMS_ON) {
      state.speechMs += FRAME_MS;
      if (state.speechMs >= BARGE_IN_MS) {
        send({ type: 'abort' });
        stopPlayback();
        state.speaking = false; // Optimistic clear so interruption audio uploads immediately
        armListening();
        beginUtterance();
      }
    } else {
      state.speechMs = 0;
    }
    return; // half duplex: never upload while he speaks
  }

  if (!listeningArmed) return;

  if (state.inUtterance) {
    if (frame) state.socket?.send(frame.buffer ?? frame);
    // When Space is held (push-to-talk), suppress VAD auto-end
    if (state.spaceHeld) return;
    if (rms < SPEECH_RMS_OFF) {
      state.silenceMs += FRAME_MS;
      if (state.silenceMs >= TRAILING_SILENCE_MS) endUtterance();
    } else {
      state.silenceMs = 0;
    }
    return;
  }

  // When Space is held (push-to-talk), suppress VAD auto-start
  if (state.spaceHeld) return;
  if (rms > SPEECH_RMS_ON) {
    state.speechMs += FRAME_MS;
    if (state.speechMs >= MIN_SPEECH_MS) { beginUtterance(); state.silenceMs = 0; }
  } else {
    state.speechMs = Math.max(0, state.speechMs - FRAME_MS);
  }
}

// --- Controls -------------------------------------------------------------
els.primary.addEventListener('click', async () => {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.closedByUser = true; state.socket.close(); stopCapture(); return;
  }
  state.closedByUser = false;
  // iOS only allows an AudioContext to start inside a user gesture, and only
  // once: everything audio-related has to be unlocked from this one tap.
  if (!state.audioContext) state.audioContext = new AudioContext();
  await state.audioContext.resume();
  await startCapture();
  connect();
  if (els.dialogue.checked) armListening();
});

els.talk.addEventListener('click', () => {
  if (!state.capturing) return;
  if (state.inUtterance) endUtterance();
  else { armListening(); beginUtterance(); }
});

els.stop.addEventListener('click', () => { send({ type: 'abort' }); stopPlayback(); state.speaking = false; setOrb('idle'); });

els.dialogue.addEventListener('change', () => {
  if (els.dialogue.checked) { armListening(); setOrb('listening'); }
  else { disarmListening(); setOrb('idle'); }
});

els.confirmYes.addEventListener('click', () => { send({ type: 'confirm', ok: true }); els.confirm.classList.remove('open'); });
els.confirmNo.addEventListener('click', () => { send({ type: 'confirm', ok: false }); els.confirm.classList.remove('open'); });

// Keyboard push-to-talk: hold Space = hold_start/hold_end, Esc = abort
document.addEventListener('keydown', (e) => {
  // Guard against keys during confirm modal
  if (els.confirm.classList.contains('open')) {
    if (e.code === 'Escape') {
      e.preventDefault();
      send({ type: 'confirm', ok: false });
      els.confirm.classList.remove('open');
    }
    return;
  }

  if (e.code === 'Space' && !state.spaceHeld && !e.repeat) {
    e.preventDefault();
    state.spaceHeld = true;
    if (!state.capturing) return;
    if (state.inUtterance) return; // already talking
    if (state.speaking) {
      // Barge-in via keyboard
      send({ type: 'abort' });
      stopPlayback();
      state.speaking = false; // Optimistic clear so interruption audio uploads immediately
    }
    armListening();
    beginUtterance();
  }
  if (e.code === 'Escape') {
    e.preventDefault();
    send({ type: 'abort' });
    stopPlayback();
    state.speaking = false;
    disarmListening();
    state.inUtterance = false;
    setOrb('idle');
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && state.spaceHeld) {
    e.preventDefault();
    state.spaceHeld = false;
    if (state.inUtterance) endUtterance();
  }
});

// A locked screen suspends the page; make that visible instead of silently dead.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setStatus('paused (screen off)');
  else if (state.socket?.readyState === WebSocket.OPEN) setStatus('connected');
});

// --- Init -----------------------------------------------------------------
loadDevicePreferences();
// Populate device list early (without mic permission prompt)
// Labels require permission; they'll update after Connect grants it.
if (navigator.mediaDevices?.enumerateDevices) {
  populateDeviceSelects();
  navigator.mediaDevices.addEventListener?.('devicechange', populateDeviceSelects);
}

// Bind device change handlers once
state.inputChangeHandler = () => {
  state.selectedInputDeviceId = els.inputDevice.value || null;
  saveDevicePreferences();
  if (state.capturing) restartCaptureWithNewDevice();
};
state.outputChangeHandler = () => {
  state.selectedOutputDeviceId = els.outputDevice.value || null;
  saveDevicePreferences();
  if (state.audioContext && state.audioContext.setSinkId) {
    const deviceId = state.selectedOutputDeviceId || undefined;
    state.audioContext.setSinkId(deviceId).catch(() => {});
  }
};
els.inputDevice.addEventListener('change', state.inputChangeHandler);
els.outputDevice.addEventListener('change', state.outputChangeHandler);
</script>
</body>
</html>`;
}
