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
<html lang="es">
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
  .row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  label.toggle { display: flex; gap: 8px; align-items: center; font-size: 14px; opacity: .8; }
  #confirm { position: fixed; inset: 0; background: rgba(0,0,0,.94); display: none; flex-direction: column;
             gap: 18px; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  #confirm.open { display: flex; }
  input[type=password] { font: inherit; background: #000; color: var(--amber); border: 2px solid var(--dim);
                         border-radius: 10px; padding: 10px 12px; width: 100%; max-width: 24rem; }
</style>
</head>
<body>
<header><span id="status">desconectado</span><span id="mode"></span></header>

<div id="orb"><div id="level"></div></div>
<div id="caption"></div>

<footer>
  <button id="primary">Conectar</button>
  <div class="row">
    <button class="secondary" id="talk">Hablar</button>
    <button class="secondary" id="stop">Callate</button>
  </div>
  <label class="toggle"><input type="checkbox" id="dialogue" checked /> Conversación abierta</label>
  <label class="toggle"><input type="checkbox" id="headphones" /> Auriculares (interrumpir mientras habla)</label>
</footer>

<div id="confirm">
  <div id="confirmText"></div>
  <div class="row">
    <button id="confirmYes">Sí</button>
    <button class="secondary" id="confirmNo">No</button>
  </div>
</div>

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
  'dialogue','headphones','confirm','confirmText','confirmYes','confirmNo']
  .map((id) => [id, document.getElementById(id)]));

const state = {
  socket: null, audioContext: null, micStream: null, workletNode: null,
  capturing: false, speaking: false, uiState: 'idle',
  speechMs: 0, silenceMs: 0, inUtterance: false,
  playQueue: [], playHead: 0, nextPlayTime: 0, sequence: 0, playedMs: 0,
  pendingConfirmId: null, closedByUser: false,
};

const setStatus = (text) => { els.status.textContent = text; };
const setCaption = (text) => { els.caption.textContent = text ?? ''; };
function setOrb(kind) {
  els.orb.className = kind;
  els.mode.textContent = kind === 'listening' ? 'escuchando'
    : kind === 'speaking' ? 'hablando' : kind === 'thinking' ? 'pensando' : '';
}

// --- Transport ------------------------------------------------------------
function deviceToken() {
  let token = localStorage.getItem('jarvis.deviceToken');
  if (!token) {
    token = prompt('Token del dispositivo (DEVICE_SHARED_SECRET)') ?? '';
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
  setStatus('conectando…');

  socket.addEventListener('open', () => {
    setStatus('conectado');
    send({ type: 'hello', deviceId: 'phone-console' });
    els.primary.textContent = 'Desconectar';
  });
  socket.addEventListener('close', () => {
    setStatus('desconectado');
    els.primary.textContent = 'Conectar';
    stopCapture();
    // Reconnect unless the user asked to stop: phones drop sockets constantly
    // when the screen dims, and a dead page that looks alive is worse.
    if (!state.closedByUser) setTimeout(connect, 1500);
  });
  socket.addEventListener('error', () => setStatus('error de conexión'));
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
      if (!state.speaking && state.uiState === 'thinking') setOrb('thinking');
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
      if (els.dialogue.checked) armListening();
      else setOrb('idle');
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
      setCaption('Error: ' + (frame.message ?? 'desconocido'));
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
  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
             channelCount: 1 },
  });
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = context.createMediaStreamSource(state.micStream);
  const node = new AudioWorkletNode(context, 'mic-worklet');
  node.port.onmessage = (event) => onMicFrame(event.data);
  source.connect(node);
  // Connected to a muted gain so the graph runs without echoing the mic.
  const silence = context.createGain(); silence.gain.value = 0;
  node.connect(silence).connect(context.destination);
  state.workletNode = node;
  state.capturing = true;
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
    if (rms < SPEECH_RMS_OFF) {
      state.silenceMs += FRAME_MS;
      if (state.silenceMs >= TRAILING_SILENCE_MS) endUtterance();
    } else {
      state.silenceMs = 0;
    }
    return;
  }

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

els.stop.addEventListener('click', () => { send({ type: 'abort' }); stopPlayback(); setOrb('idle'); });

els.dialogue.addEventListener('change', () => {
  if (els.dialogue.checked) armListening(); else { disarmListening(); setOrb('idle'); }
});

els.confirmYes.addEventListener('click', () => { send({ type: 'confirm', ok: true }); els.confirm.classList.remove('open'); });
els.confirmNo.addEventListener('click', () => { send({ type: 'confirm', ok: false }); els.confirm.classList.remove('open'); });

// A locked screen suspends the page; make that visible instead of silently dead.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setStatus('en pausa (pantalla apagada)');
  else if (state.socket?.readyState === WebSocket.OPEN) setStatus('conectado');
});
</script>
</body>
</html>`;
}
