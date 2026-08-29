import { describe, expect, it } from 'bun:test';

import { synthesizeSpeechWithLocal } from '@/voice/localtts';

function buildPcmResponse(
  pcmBytes: Uint8Array,
  contentType = 'audio/L16; rate=24000; channels=1',
  status = 200,
): Response {
  return new Response(pcmBytes.buffer as ArrayBuffer, {
    status,
    headers: { 'Content-Type': contentType },
  });
}

function buildJsonSidecarResponse(pcmBytes: Uint8Array, sampleRate = 24_000): Response {
  let binary = '';
  for (const byteValue of pcmBytes) {
    binary += String.fromCharCode(byteValue);
  }
  return new Response(
    JSON.stringify({ data: btoa(binary), sample_rate: sampleRate, format: 'pcm' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const samplePcm = new Uint8Array([1, 2, 3, 4, 5, 6]);

describe('synthesizeSpeechWithLocal', () => {
  it('returns raw PCM on success and posts the correct payload', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const fetchImplementation = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      return buildPcmResponse(samplePcm);
    }) as unknown as typeof fetch;

    const pcm = await synthesizeSpeechWithLocal({
      localTtsUrl: 'https://tts.ygdcbtmc4u.uk/',
      text: '  hola mundo  ',
      voice: 'af_heart',
      modelId: 'kokoro',
      fetchImplementation,
    });

    expect(new Uint8Array(pcm)).toEqual(samplePcm);
    expect(capturedUrl).toBe('https://tts.ygdcbtmc4u.uk/v1/audio/speech');
    const body = JSON.parse(capturedBody) as Record<string, string>;
    expect(body.input).toBe('hola mundo');
    expect(body.voice).toBe('af_heart');
    expect(body.response_format).toBe('pcm');
  });

  it('trims trailing slashes from the base URL', async () => {
    const fetchImplementation = (async () =>
      buildPcmResponse(samplePcm)) as unknown as typeof fetch;
    const pcm = await synthesizeSpeechWithLocal({
      localTtsUrl: 'https://tts.ygdcbtmc4u.uk///',
      text: 'hola',
      fetchImplementation,
    });
    expect(new Uint8Array(pcm)).toEqual(samplePcm);
  });

  it('throws on non-2xx', async () => {
    const fetchImplementation = (async () =>
      new Response('error', { status: 502 })) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: 'hola',
        fetchImplementation,
      }),
    ).rejects.toThrow(/502/);
  });

  it('throws on empty body', async () => {
    const fetchImplementation = (async () =>
      new Response(new ArrayBuffer(0), {
        status: 200,
        headers: { 'Content-Type': 'audio/L16; rate=24000' },
      })) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: 'hola',
        fetchImplementation,
      }),
    ).rejects.toThrow(/vacío/);
  });

  it('throws on empty text before fetching', async () => {
    let called = false;
    const fetchImplementation = (async () => {
      called = true;
      return buildPcmResponse(samplePcm);
    }) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: '   ',
        fetchImplementation,
      }),
    ).rejects.toThrow(/vacío/);
    expect(called).toBe(false);
  });

  it('rejects wrong content-type (html/interstitial)', async () => {
    const fetchImplementation = (async () =>
      new Response(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: 'hola',
        fetchImplementation,
      }),
    ).rejects.toThrow(/content-type/i);
  });

  it('rejects WAV when PCM was requested', async () => {
    const fetchImplementation = (async () =>
      new Response(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: 'hola',
        fetchImplementation,
      }),
    ).rejects.toThrow(/WAV/);
  });

  it('rejects wrong sample rate in content-type', async () => {
    const fetchImplementation = (async () =>
      buildPcmResponse(
        samplePcm,
        'audio/L16; rate=22050; channels=1',
      )) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: 'hola',
        fetchImplementation,
      }),
    ).rejects.toThrow(/22050/);
  });

  it('decodes the JSON sidecar when content-type is json', async () => {
    const fetchImplementation = (async () =>
      buildJsonSidecarResponse(samplePcm)) as unknown as typeof fetch;
    const pcm = await synthesizeSpeechWithLocal({
      localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
      text: 'hola',
      fetchImplementation,
    });
    expect(new Uint8Array(pcm)).toEqual(samplePcm);
  });

  it('rejects JSON sidecar with wrong sample_rate', async () => {
    const fetchImplementation = (async () =>
      buildJsonSidecarResponse(samplePcm, 22050)) as unknown as typeof fetch;
    await expect(
      synthesizeSpeechWithLocal({
        localTtsUrl: 'https://tts.ygdcbtmc4u.uk',
        text: 'hola',
        fetchImplementation,
      }),
    ).rejects.toThrow(/22050/);
  });
});
