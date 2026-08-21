import { describe, expect, it } from 'bun:test';

import { synthesizeSpeechWithGemini } from '@/voice/gemini';

function buildGeminiAudioResponse(input: {
  readonly mimeType: string;
  readonly pcmBytes: Uint8Array;
}): Response {
  let binary = '';
  for (const byteValue of input.pcmBytes) {
    binary += String.fromCharCode(byteValue);
  }
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: input.mimeType, data: btoa(binary) } }],
          },
        },
      ],
    }),
    { status: 200 },
  );
}

const pcmBytes = new Uint8Array([9, 8, 7, 6, 5, 4]);

describe('synthesizeSpeechWithGemini', () => {
  it('decodes the inline base64 PCM the device plays directly', async () => {
    const fetchImplementation = (async () =>
      buildGeminiAudioResponse({
        mimeType: 'audio/L16;codec=pcm;rate=24000',
        pcmBytes,
      })) as unknown as typeof fetch;

    const pcm = await synthesizeSpeechWithGemini({
      geminiApiKey: 'test-key',
      text: 'hola',
      voiceName: 'Charon',
      fetchImplementation,
    });

    expect(new Uint8Array(pcm)).toEqual(pcmBytes);
  });

  it('rejects a sample rate the device would play back too fast', async () => {
    const fetchImplementation = (async () =>
      buildGeminiAudioResponse({
        mimeType: 'audio/L16;codec=pcm;rate=16000',
        pcmBytes,
      })) as unknown as typeof fetch;

    await expect(
      synthesizeSpeechWithGemini({
        geminiApiKey: 'test-key',
        text: 'hola',
        voiceName: 'Charon',
        fetchImplementation,
      }),
    ).rejects.toThrow(/16000Hz/);
  });

  it('throws when the model returns no audio part', async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{}] } }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      synthesizeSpeechWithGemini({
        geminiApiKey: 'test-key',
        text: 'hola',
        voiceName: 'Charon',
        fetchImplementation,
      }),
    ).rejects.toThrow('TTS (Gemini) no devolvió audio');
  });

  it('surfaces the upstream status on failure', async () => {
    const fetchImplementation = (async () =>
      new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch;

    await expect(
      synthesizeSpeechWithGemini({
        geminiApiKey: 'test-key',
        text: 'hola',
        voiceName: 'Charon',
        fetchImplementation,
      }),
    ).rejects.toThrow(/429/);
  });
});
