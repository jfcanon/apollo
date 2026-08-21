import { z } from 'zod';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// The device plays raw PCM directly, and Gemini's speech models emit exactly
// that: `audio/L16;codec=pcm;rate=24000` — 16-bit little-endian mono at 24 kHz,
// with no container to strip. The rate is still asserted rather than assumed,
// because a model revision that switched to 16 kHz would otherwise play back
// fast and sound like a hardware fault.
const DEVICE_PCM_SAMPLE_RATE_HZ = 24_000;

const geminiInlineDataSchema = z.object({
  mimeType: z.string(),
  data: z.string(),
});

const geminiSpeechResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z
            .array(
              z.object({
                inlineData: geminiInlineDataSchema.optional(),
              }),
            )
            .min(1),
        }),
      }),
    )
    .min(1),
});

function decodeBase64ToArrayBuffer(base64Text: string): ArrayBuffer {
  const binaryString = atob(base64Text);
  const byteArray = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    byteArray[index] = binaryString.charCodeAt(index);
  }
  return byteArray.buffer;
}

function readSampleRateFromMimeType(mimeType: string): number | undefined {
  // e.g. "audio/L16;codec=pcm;rate=24000"
  const rateMatch = /rate=(\d+)/.exec(mimeType);
  return rateMatch === null ? undefined : Number.parseInt(rateMatch[1], 10);
}

// Gemini's free tier covers speech synthesis over plain HTTPS, so this path
// spends no Workers AI neurons and needs no Cloudflare AI binding.
export async function synthesizeSpeechWithGemini(input: {
  readonly geminiApiKey: string;
  readonly text: string;
  readonly voiceName: string;
  readonly modelId?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<ArrayBuffer> {
  const modelId = input.modelId ?? 'gemini-2.5-flash-preview-tts';
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImplementation(
    `${GEMINI_API_BASE_URL}/models/${modelId}:generateContent?key=${encodeURIComponent(
      input.geminiApiKey,
    )}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: input.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } },
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const failureDetail = await response.text().catch(() => '');
    throw new Error(
      `TTS (Gemini) falló con status ${response.status}${
        failureDetail === '' ? '' : `: ${failureDetail.slice(0, 200)}`
      }`,
    );
  }

  const payload = geminiSpeechResponseSchema.parse(await response.json());
  const inlineData = payload.candidates[0].content.parts.find(
    (part) => part.inlineData !== undefined,
  )?.inlineData;
  if (inlineData === undefined) {
    throw new Error('TTS (Gemini) no devolvió audio');
  }

  const sampleRateHz = readSampleRateFromMimeType(inlineData.mimeType);
  if (sampleRateHz !== undefined && sampleRateHz !== DEVICE_PCM_SAMPLE_RATE_HZ) {
    throw new Error(
      `TTS (Gemini) devolvió ${sampleRateHz}Hz; el dispositivo requiere ` +
        `${DEVICE_PCM_SAMPLE_RATE_HZ}Hz (mime: ${inlineData.mimeType})`,
    );
  }

  return decodeBase64ToArrayBuffer(inlineData.data);
}
