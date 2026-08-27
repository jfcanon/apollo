import { describe, expect, it } from 'bun:test';

import { transcribeAudioWithGroq } from '@/voice/stt';

type CapturedFetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

function createCapturingFetchMock(
  responseBody: unknown,
  status = 200,
): {
  readonly fetchImplementation: typeof fetch;
  readonly callList: CapturedFetchCall[];
} {
  const callList: CapturedFetchCall[] = [];
  const fetchHandler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), { status });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, {
      preconnect: () => {},
    }) as typeof fetch,
    callList,
  };
}

describe('transcribeAudioWithGroq', () => {
  it('base64-encodes the audio and defaults language', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      text: '  hola apolo  ',
    });

    const transcript = await transcribeAudioWithGroq({
      audioBuffer: new Uint8Array([1, 2, 3]).buffer,
      groqApiKey: 'key-123',
      modelId: 'whisper-large-v3-turbo',
      fetchImplementation,
    });

    expect(transcript).toBe('hola apolo');
    expect(callList[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const requestBody = JSON.parse(callList[0].init.body as string) as {
      language: string;
      file: string;
    };
    expect(requestBody.language).toBe('es');
    expect(requestBody.file).toContain('data:audio/wav;base64,');
  });

  it('honors an explicit language', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({ text: 'hi' });

    await transcribeAudioWithGroq({
      audioBuffer: new Uint8Array([9]).buffer,
      groqApiKey: 'key-123',
      modelId: 'whisper-large-v3-turbo',
      languageCode: 'en',
      fetchImplementation,
    });

    const requestBody = JSON.parse(callList[0].init.body as string) as {
      language: string;
    };
    expect(requestBody.language).toBe('en');
  });

  it('throws on a non-ok response', async () => {
    const { fetchImplementation } = createCapturingFetchMock({}, 500);
    await expect(
      transcribeAudioWithGroq({
        audioBuffer: new ArrayBuffer(0),
        groqApiKey: 'key-123',
        modelId: 'whisper-large-v3-turbo',
        fetchImplementation,
      }),
    ).rejects.toThrow('STT falló con status 500');
  });

  it('throws when the transcript is empty', async () => {
    const { fetchImplementation } = createCapturingFetchMock({ text: '   ' });
    await expect(
      transcribeAudioWithGroq({
        audioBuffer: new ArrayBuffer(0),
        groqApiKey: 'key-123',
        modelId: 'whisper-large-v3-turbo',
        fetchImplementation,
      }),
    ).rejects.toThrow('STT devolvió texto vacío');
  });

  it('throws when the response does not match the expected schema', async () => {
    const { fetchImplementation } = createCapturingFetchMock({ text: 42 });
    await expect(
      transcribeAudioWithGroq({
        audioBuffer: new ArrayBuffer(0),
        groqApiKey: 'key-123',
        modelId: 'whisper-large-v3-turbo',
        fetchImplementation,
      }),
    ).rejects.toThrow();
  });
});
