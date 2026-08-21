import { describe, expect, it } from 'bun:test';

import { synthesizeSpeechWithGroq, transcribeAudioWithGroq } from '@/voice/groq';

// Builds a RIFF/WAV container by hand so the parser is exercised against real
// byte layouts, including the padded/extra-chunk shapes encoders actually emit.
function buildWavBuffer(input: {
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly bitsPerSample: number;
  readonly pcmBytes: Uint8Array;
  readonly includeListChunk?: boolean;
  readonly declaredDataSize?: number;
}): ArrayBuffer {
  const listChunk = input.includeListChunk === true;
  // 'LIST' + size + 4 bytes of payload
  const listChunkByteLength = listChunk ? 12 : 0;
  const totalByteLength = 12 + 24 + listChunkByteLength + 8 + input.pcmBytes.length;
  const buffer = new ArrayBuffer(totalByteLength);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string): void => {
    for (let index = 0; index < 4; index += 1) {
      view.setUint8(offset + index, tag.charCodeAt(index));
    }
  };

  writeTag(0, 'RIFF');
  view.setUint32(4, totalByteLength - 8, true);
  writeTag(8, 'WAVE');

  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, input.channelCount, true);
  view.setUint32(24, input.sampleRateHz, true);
  view.setUint32(28, 0, true); // byte rate (unused by the parser)
  view.setUint16(32, 0, true); // block align (unused)
  view.setUint16(34, input.bitsPerSample, true);

  let cursor = 36;
  if (listChunk) {
    writeTag(cursor, 'LIST');
    view.setUint32(cursor + 4, 4, true);
    cursor += 12;
  }

  writeTag(cursor, 'data');
  view.setUint32(cursor + 4, input.declaredDataSize ?? input.pcmBytes.length, true);
  new Uint8Array(buffer, cursor + 8).set(input.pcmBytes);
  return buffer;
}

const deviceGradePcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function stubTtsFetch(wavBuffer: ArrayBuffer): typeof fetch {
  return (async () =>
    new Response(wavBuffer, { status: 200 })) as unknown as typeof fetch;
}

describe('synthesizeSpeechWithGroq', () => {
  it('returns the bare PCM payload, not the RIFF container', async () => {
    const wavBuffer = buildWavBuffer({
      sampleRateHz: 24_000,
      channelCount: 1,
      bitsPerSample: 16,
      pcmBytes: deviceGradePcm,
    });

    const pcm = await synthesizeSpeechWithGroq({
      groqApiKey: 'test-key',
      text: 'hola',
      voice: 'tara',
      fetchImplementation: stubTtsFetch(wavBuffer),
    });

    expect(new Uint8Array(pcm)).toEqual(deviceGradePcm);
  });

  it('finds the data chunk even when the encoder inserts a LIST chunk', async () => {
    // A fixed 44-byte header assumption would silently return garbage here.
    const wavBuffer = buildWavBuffer({
      sampleRateHz: 24_000,
      channelCount: 1,
      bitsPerSample: 16,
      pcmBytes: deviceGradePcm,
      includeListChunk: true,
    });

    const pcm = await synthesizeSpeechWithGroq({
      groqApiKey: 'test-key',
      text: 'hola',
      voice: 'tara',
      fetchImplementation: stubTtsFetch(wavBuffer),
    });

    expect(new Uint8Array(pcm)).toEqual(deviceGradePcm);
  });

  it('reads to the end of the buffer when a streamed WAV declares size 0', async () => {
    const wavBuffer = buildWavBuffer({
      sampleRateHz: 24_000,
      channelCount: 1,
      bitsPerSample: 16,
      pcmBytes: deviceGradePcm,
      declaredDataSize: 0,
    });

    const pcm = await synthesizeSpeechWithGroq({
      groqApiKey: 'test-key',
      text: 'hola',
      voice: 'tara',
      fetchImplementation: stubTtsFetch(wavBuffer),
    });

    expect(new Uint8Array(pcm)).toEqual(deviceGradePcm);
  });

  it('rejects a sample rate the device cannot play instead of shipping fast audio', async () => {
    const wavBuffer = buildWavBuffer({
      sampleRateHz: 44_100,
      channelCount: 1,
      bitsPerSample: 16,
      pcmBytes: deviceGradePcm,
    });

    await expect(
      synthesizeSpeechWithGroq({
        groqApiKey: 'test-key',
        text: 'hola',
        voice: 'tara',
        fetchImplementation: stubTtsFetch(wavBuffer),
      }),
    ).rejects.toThrow(/44100Hz/);
  });

  it('rejects stereo output the device would play as noise', async () => {
    const wavBuffer = buildWavBuffer({
      sampleRateHz: 24_000,
      channelCount: 2,
      bitsPerSample: 16,
      pcmBytes: deviceGradePcm,
    });

    await expect(
      synthesizeSpeechWithGroq({
        groqApiKey: 'test-key',
        text: 'hola',
        voice: 'tara',
        fetchImplementation: stubTtsFetch(wavBuffer),
      }),
    ).rejects.toThrow(/2ch/);
  });

  it('surfaces the terms-acceptance failure with its detail', async () => {
    const fetchImplementation = (async () =>
      new Response('{"error":{"message":"requires terms acceptance"}}', {
        status: 400,
      })) as unknown as typeof fetch;

    await expect(
      synthesizeSpeechWithGroq({
        groqApiKey: 'test-key',
        text: 'hola',
        voice: 'tara',
        fetchImplementation,
      }),
    ).rejects.toThrow(/terms acceptance/);
  });
});

describe('transcribeAudioWithGroq', () => {
  it('returns the trimmed transcript', async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ text: '  hola jarvis  ' }), {
        status: 200,
      })) as unknown as typeof fetch;

    const transcript = await transcribeAudioWithGroq({
      groqApiKey: 'test-key',
      audioBuffer: new ArrayBuffer(8),
      fetchImplementation,
    });

    expect(transcript).toBe('hola jarvis');
  });

  it('throws on empty transcripts so silence is never spoken back', async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ text: '   ' }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      transcribeAudioWithGroq({
        groqApiKey: 'test-key',
        audioBuffer: new ArrayBuffer(8),
        fetchImplementation,
      }),
    ).rejects.toThrow('STT devolvió texto vacío');
  });

  it('reports the upstream status when Groq rejects the request', async () => {
    const fetchImplementation = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;

    await expect(
      transcribeAudioWithGroq({
        groqApiKey: 'test-key',
        audioBuffer: new ArrayBuffer(8),
        fetchImplementation,
      }),
    ).rejects.toThrow(/429/);
  });
});
