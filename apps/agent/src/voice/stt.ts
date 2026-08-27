import { z } from 'zod';

const groqTranscriptionResponseSchema = z.object({
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

export async function transcribeAudioWithGroq(input: {
  readonly audioBuffer: ArrayBuffer;
  readonly groqApiKey: string;
  readonly modelId?: string;
  readonly languageCode?: string;
  readonly audioFormat?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<string> {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const modelId = input.modelId ?? 'whisper-large-v3-turbo';
  const response = await fetchImplementation(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        language: input.languageCode ?? 'es',
        file: `data:audio/wav;base64,${encodeArrayBufferAsBase64(input.audioBuffer)}`,
      }),
    },
  );

  if (!response.ok) {
    const failureDetail = await response.text().catch(() => '');
    const audioKilobytes = Math.round(input.audioBuffer.byteLength / 1024);
    throw new Error(
      `STT falló con status ${response.status} (${audioKilobytes} kB de audio): ${failureDetail.slice(0, 500)}`,
    );
  }

  const payload = groqTranscriptionResponseSchema.parse(await response.json());
  const transcript = payload.text?.trim() ?? '';
  if (transcript.length === 0) {
    throw new Error('STT devolvió texto vacío');
  }
  return transcript;
}
