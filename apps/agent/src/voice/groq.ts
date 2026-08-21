import { z } from 'zod';

const groqTranscriptionResponseSchema = z.object({
  text: z.string().optional(),
});

const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1';

// The device plays raw PCM with no decoder and no resampler, so anything that
// is not exactly this has to fail loudly rather than reach the speaker.
const DEVICE_PCM_SAMPLE_RATE_HZ = 24_000;
const DEVICE_PCM_CHANNEL_COUNT = 1;
const DEVICE_PCM_BITS_PER_SAMPLE = 16;

const WAV_PCM_FORMAT_TAG = 1;

type WavAudioDescription = {
  readonly pcmData: ArrayBuffer;
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly bitsPerSample: number;
  readonly formatTag: number;
};

// Groq returns a RIFF container, but the device contract is bare PCM. The header
// is NOT reliably 44 bytes — encoders emit LIST/fact chunks — so the chunks are
// walked instead of assuming an offset. Guessing here produces audio that plays
// as noise or silence, which is indistinguishable from "TTS is broken".
function readPcmFromWavContainer(wavBuffer: ArrayBuffer): WavAudioDescription {
  const wavBytes = new DataView(wavBuffer);
  if (wavBuffer.byteLength < 12) {
    throw new Error('TTS devolvió un WAV truncado');
  }
  const riffTag = String.fromCharCode(
    wavBytes.getUint8(0),
    wavBytes.getUint8(1),
    wavBytes.getUint8(2),
    wavBytes.getUint8(3),
  );
  if (riffTag !== 'RIFF') {
    throw new Error('TTS no devolvió un contenedor RIFF/WAV');
  }

  let cursor = 12;
  let formatTag: number | undefined;
  let channelCount: number | undefined;
  let sampleRateHz: number | undefined;
  let bitsPerSample: number | undefined;
  let pcmData: ArrayBuffer | undefined;

  while (cursor + 8 <= wavBuffer.byteLength) {
    const chunkId = String.fromCharCode(
      wavBytes.getUint8(cursor),
      wavBytes.getUint8(cursor + 1),
      wavBytes.getUint8(cursor + 2),
      wavBytes.getUint8(cursor + 3),
    );
    const chunkSize = wavBytes.getUint32(cursor + 4, true);
    const chunkStart = cursor + 8;

    if (chunkId === 'fmt ') {
      formatTag = wavBytes.getUint16(chunkStart, true);
      channelCount = wavBytes.getUint16(chunkStart + 2, true);
      sampleRateHz = wavBytes.getUint32(chunkStart + 4, true);
      bitsPerSample = wavBytes.getUint16(chunkStart + 14, true);
    } else if (chunkId === 'data') {
      // A streamed WAV can declare size 0 and run to the end of the buffer.
      const availableByteLength = wavBuffer.byteLength - chunkStart;
      const dataByteLength =
        chunkSize === 0 ? availableByteLength : Math.min(chunkSize, availableByteLength);
      pcmData = wavBuffer.slice(chunkStart, chunkStart + dataByteLength);
    }

    // Chunks are word-aligned: an odd size carries one pad byte.
    cursor = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (
    formatTag === undefined ||
    channelCount === undefined ||
    sampleRateHz === undefined ||
    bitsPerSample === undefined ||
    pcmData === undefined
  ) {
    throw new Error('TTS devolvió un WAV sin fmt/data legibles');
  }

  return { pcmData, sampleRateHz, channelCount, bitsPerSample, formatTag };
}

function assertPcmMatchesDeviceContract(audio: WavAudioDescription): void {
  if (
    audio.formatTag !== WAV_PCM_FORMAT_TAG ||
    audio.sampleRateHz !== DEVICE_PCM_SAMPLE_RATE_HZ ||
    audio.channelCount !== DEVICE_PCM_CHANNEL_COUNT ||
    audio.bitsPerSample !== DEVICE_PCM_BITS_PER_SAMPLE
  ) {
    // Loud and specific: the device would otherwise play this at the wrong
    // speed (or as noise) and the fault would look like a hardware problem.
    throw new Error(
      `TTS devolvió PCM incompatible con el dispositivo: formato ${audio.formatTag}, ` +
        `${audio.sampleRateHz}Hz, ${audio.channelCount}ch, ${audio.bitsPerSample}bit ` +
        `(se requiere formato 1, ${DEVICE_PCM_SAMPLE_RATE_HZ}Hz, ` +
        `${DEVICE_PCM_CHANNEL_COUNT}ch, ${DEVICE_PCM_BITS_PER_SAMPLE}bit)`,
    );
  }
}

// Groq's free tier serves whisper-large-v3-turbo — the same model family the
// Workers AI path used — over a plain multipart endpoint, so it needs no
// Cloudflare AI binding and none of its daily neuron allowance.
export async function transcribeAudioWithGroq(input: {
  readonly groqApiKey: string;
  readonly audioBuffer: ArrayBuffer;
  readonly modelId?: string;
  readonly languageCode?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<string> {
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([input.audioBuffer], { type: 'audio/wav' }),
    'audio.wav',
  );
  formData.append('model', input.modelId ?? 'whisper-large-v3-turbo');
  formData.append('response_format', 'json');
  if (input.languageCode !== undefined) {
    formData.append('language', input.languageCode);
  }

  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImplementation(
    `${GROQ_API_BASE_URL}/audio/transcriptions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.groqApiKey}` },
      body: formData,
    },
  );

  if (!response.ok) {
    throw new Error(`STT (Groq) falló con status ${response.status}`);
  }

  const payload = groqTranscriptionResponseSchema.parse(await response.json());
  const transcript = payload.text?.trim() ?? '';
  if (transcript.length === 0) {
    throw new Error('STT devolvió texto vacío');
  }
  return transcript;
}

// Groq speech returns a WAV container; the device wants the bare PCM inside it.
export async function synthesizeSpeechWithGroq(input: {
  readonly groqApiKey: string;
  readonly text: string;
  readonly voice: string;
  readonly modelId?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<ArrayBuffer> {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImplementation(`${GROQ_API_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelId ?? 'canopylabs/orpheus-v1-english',
      input: input.text,
      voice: input.voice,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    // 400 "requires terms acceptance" is the expected first failure: the org
    // admin has to accept the model terms once in the Groq console.
    const failureDetail = await response.text().catch(() => '');
    throw new Error(
      `TTS (Groq) falló con status ${response.status}${
        failureDetail === '' ? '' : `: ${failureDetail.slice(0, 200)}`
      }`,
    );
  }

  const audio = readPcmFromWavContainer(await response.arrayBuffer());
  assertPcmMatchesDeviceContract(audio);
  return audio.pcmData;
}
