import { z } from 'zod';

const workersAiTranscriptionResponseSchema = z.object({
  text: z.string().optional(),
});

function encodeArrayBufferAsBase64(arrayBuffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(arrayBuffer);
  let binaryString = '';
  for (const byteValue of byteArray) {
    binaryString += String.fromCharCode(byteValue);
  }
  return btoa(binaryString);
}

// Whisper on Workers AI runs inside the same Worker via the AI binding: no
// external key, no cross-provider hop, and it bills against the daily free
// neuron allowance before it ever costs money. vad_filter stays on because
// silence otherwise comes back as hallucinated words that get spoken aloud.
export async function transcribeAudioWithWorkersAi(input: {
  readonly ai: Ai;
  readonly audioBuffer: ArrayBuffer;
  readonly modelId?: string;
  readonly languageCode?: string;
}): Promise<string> {
  const rawResult: unknown = await input.ai.run(
    (input.modelId ?? '@cf/openai/whisper-large-v3-turbo') as keyof AiModels,
    {
      audio: encodeArrayBufferAsBase64(input.audioBuffer),
      vad_filter: 'true',
      ...(input.languageCode !== undefined ? { language: input.languageCode } : {}),
    } as never,
  );

  const payload = workersAiTranscriptionResponseSchema.parse(rawResult);
  const transcript = payload.text?.trim() ?? '';
  if (transcript.length === 0) {
    throw new Error('STT devolvió texto vacío');
  }
  return transcript;
}

// The device has no decoder: the TTS contract is raw 24 kHz s16le mono PCM.
// Aura emits exactly that with encoding=linear16 + sample_rate=24000, so the
// bytes go to the device untouched. (MeloTTS is cheaper per minute but returns
// MP3, which would need a decode stage in the Worker — deliberately not this
// default.)
export async function synthesizeSpeechWithWorkersAi(input: {
  readonly ai: Ai;
  readonly text: string;
  readonly speaker: string;
  readonly modelId?: string;
}): Promise<ArrayBuffer> {
  const rawResult: unknown = await input.ai.run(
    (input.modelId ?? '@cf/deepgram/aura-2-en') as keyof AiModels,
    {
      text: input.text,
      speaker: input.speaker,
      encoding: 'linear16',
      sample_rate: 24000,
      container: 'none',
    } as never,
  );

  if (rawResult instanceof ReadableStream) {
    return new Response(rawResult).arrayBuffer();
  }
  if (rawResult instanceof ArrayBuffer) {
    return rawResult;
  }
  if (rawResult instanceof Uint8Array) {
    return rawResult.slice().buffer as ArrayBuffer;
  }

  // Some audio models wrap the bytes as base64 under an `audio` key instead of
  // streaming them; accept that shape rather than failing the whole turn.
  const wrappedAudio = z.object({ audio: z.string() }).safeParse(rawResult);
  if (wrappedAudio.success) {
    const binaryString = atob(wrappedAudio.data.audio);
    const byteArray = new Uint8Array(binaryString.length);
    for (let index = 0; index < binaryString.length; index += 1) {
      byteArray[index] = binaryString.charCodeAt(index);
    }
    return byteArray.buffer;
  }

  throw new Error('TTS devolvió un formato de audio desconocido');
}
