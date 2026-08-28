import { z } from 'zod';

const localTranscriptionResponseSchema = z.object({
  text: z.string().optional(),
});

export async function transcribeAudioWithLocal(input: {
  readonly localSttUrl: string;
  readonly audioBuffer: ArrayBuffer;
  readonly languageCode?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<string> {
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([input.audioBuffer], { type: 'audio/wav' }),
    'audio.wav',
  );
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'json');
  if (input.languageCode !== undefined) {
    formData.append('language', input.languageCode);
  }

  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImplementation(
    `${input.localSttUrl}/v1/audio/transcriptions`,
    {
      method: 'POST',
      body: formData,
    },
  );

  if (!response.ok) {
    throw new Error(`STT (local) falló con status ${response.status}`);
  }

  const payload = localTranscriptionResponseSchema.parse(await response.json());
  const transcript = payload.text?.trim() ?? '';
  if (transcript.length === 0) {
    throw new Error('STT devolvió texto vacío');
  }
  return transcript;
}
