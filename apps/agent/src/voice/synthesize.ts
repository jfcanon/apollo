import { synthesizeSpeechWithElevenLabs } from '@/voice/elevenlabs';
import { synthesizeSpeechWithGemini } from '@/voice/gemini';
import { synthesizeSpeechWithGroq } from '@/voice/groq';
import { synthesizeSpeechWithLocal } from '@/voice/localtts';
import { synthesizeSpeechThroughCache } from '@/voice/ttscache';
import { synthesizeSpeechWithWorkersAi } from '@/voice/workersai';

// The one production speech path: every caller gets the R2 cache, so a repeated
// utterance is never synthesised twice.
//
// This honours VOICE_PROVIDER exactly like the conversation runtime does.
// It used to call ElevenLabs unconditionally, which meant notifications and
// reminders kept failing with 401 while conversation audio worked — and a
// failed announcement is retried on every telemetry tick, so the device played
// its earcon once a minute forever. Speech has to follow the configured
// provider or "delivered" can never become true.
export async function synthesizeApolloSpeech(input: {
  readonly environment: Env;
  readonly text: string;
  readonly voiceId: string;
}): Promise<ArrayBuffer> {
  const { environment, text } = input;

  if (environment.VOICE_PROVIDER === 'free') {
    const voiceName = environment.GEMINI_TTS_VOICE ?? 'Charon';
    const modelId = environment.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts';
    return synthesizeSpeechThroughCache({
      mediaBucket: environment.MEDIA,
      text,
      voiceId: voiceName,
      modelId,
      synthesize: () =>
        synthesizeSpeechWithGemini({
          geminiApiKey: environment.GEMINI_API_KEY ?? '',
          text,
          voiceName,
          modelId,
        }),
    });
  }

  if (environment.VOICE_PROVIDER === 'groq') {
    const voice = environment.GROQ_TTS_VOICE ?? 'tara';
    const modelId = environment.GROQ_TTS_MODEL ?? 'canopylabs/orpheus-v1-english';
    return synthesizeSpeechThroughCache({
      mediaBucket: environment.MEDIA,
      text,
      voiceId: voice,
      modelId,
      synthesize: () =>
        synthesizeSpeechWithGroq({
          groqApiKey: environment.GROQ_API_KEY ?? '',
          text,
          voice,
          modelId,
        }),
    });
  }

  if (environment.VOICE_PROVIDER === 'workersai') {
    const speaker = environment.AURA_SPEAKER ?? 'draco';
    const modelId = environment.WORKERSAI_TTS_MODEL ?? '@cf/deepgram/aura-2-en';
    return synthesizeSpeechThroughCache({
      mediaBucket: environment.MEDIA,
      text,
      voiceId: speaker,
      modelId,
      synthesize: () =>
        synthesizeSpeechWithWorkersAi({
          ai: environment.AI,
          text,
          speaker,
          modelId,
        }),
    });
  }

  if (environment.VOICE_PROVIDER === 'local') {
    const voice = environment.LOCAL_TTS_VOICE ?? 'af_heart';
    const modelId = environment.LOCAL_TTS_MODEL ?? 'kokoro';
    return synthesizeSpeechThroughCache({
      mediaBucket: environment.MEDIA,
      text,
      voiceId: voice,
      modelId,
      synthesize: () =>
        synthesizeSpeechWithLocal({
          localTtsUrl: environment.LOCAL_TTS_URL ?? 'https://tts.ygdcbtmc4u.uk',
          text,
          voice,
          modelId,
        }),
    });
  }

  return synthesizeSpeechThroughCache({
    mediaBucket: environment.MEDIA,
    text,
    voiceId: input.voiceId,
    modelId: environment.ELEVENLABS_TTS_MODEL,
    synthesize: () =>
      synthesizeSpeechWithElevenLabs({
        text,
        voiceId: input.voiceId,
        elevenLabsApiKey: environment.ELEVENLABS_API_KEY,
        modelId: environment.ELEVENLABS_TTS_MODEL,
      }),
  });
}
