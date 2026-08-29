import { z } from 'zod';

const localTranscriptionResponseSchema = z.object({
  text: z.string().optional(),
  duration: z.number().optional(),
  language: z.string().optional(),
  backend: z.string().optional(),
  latency_ms: z.number().optional(),
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().optional(),
});

export type LocalTranscriptionResult = {
  readonly transcript: string;
  readonly duration: number | undefined;
  readonly language: string | undefined;
  readonly backend: string | undefined;
  readonly latencyMs: number | undefined;
  readonly avgLogprob: number | undefined;
  readonly noSpeechProb: number | undefined;
};

export async function transcribeAudioWithLocal(input: {
  readonly localSttUrl: string;
  readonly audioBuffer: ArrayBuffer;
  readonly languageCode?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<LocalTranscriptionResult> {
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

  return {
    transcript,
    duration: payload.duration,
    language: payload.language,
    backend: payload.backend,
    latencyMs: payload.latency_ms,
    avgLogprob: payload.avg_logprob,
    noSpeechProb: payload.no_speech_prob,
  };
}
