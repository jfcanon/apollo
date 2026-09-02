import { z } from 'zod';

const DEVICE_PCM_SAMPLE_RATE_HZ = 24_000;

export async function synthesizeSpeechWithLocal(input: {
  readonly localTtsUrl: string;
  readonly text: string;
  readonly voice?: string;
  readonly modelId?: string;
  readonly responseFormat?: 'pcm' | 'wav';
  readonly fetchImplementation?: typeof fetch;
}): Promise<ArrayBuffer> {
  const normalizedText = input.text.trim();
  if (normalizedText.length === 0) {
    throw new Error('TTS (local) recibió texto vacío');
  }

  const localTtsUrl = input.localTtsUrl.replace(/\/+$/, '');
  const voice = input.voice ?? 'af_heart';
  const modelId = input.modelId ?? 'kokoro';
  const responseFormat = input.responseFormat ?? 'pcm';
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;

  const response = await fetchImplementation(`${localTtsUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      input: normalizedText,
      voice,
      response_format: responseFormat,
    }),
  });

  if (!response.ok) {
    const failureDetail = await response.text().catch(() => '');
    throw new Error(
      `TTS (local) falló con status ${response.status}${
        failureDetail === '' ? '' : `: ${failureDetail.slice(0, 200)}`
      }`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const arrayBuffer = await response.arrayBuffer();

  if (arrayBuffer.byteLength === 0) {
    throw new Error('TTS (local) devolvió audio vacío');
  }

  if (contentType.includes('application/json')) {
    const jsonSchema = z.object({
      data: z.string(),
      sample_rate: z.number().optional(),
    });
    const payload = jsonSchema.parse(JSON.parse(new TextDecoder().decode(arrayBuffer)));
    const sampleRateHz = payload.sample_rate;
    if (sampleRateHz !== undefined && sampleRateHz !== DEVICE_PCM_SAMPLE_RATE_HZ) {
      throw new Error(
        `TTS (local) devolvió ${sampleRateHz}Hz; el dispositivo requiere ${DEVICE_PCM_SAMPLE_RATE_HZ}Hz`,
      );
    }
    const binaryString = atob(payload.data);
    const byteArray = new Uint8Array(binaryString.length);
    for (let index = 0; index < binaryString.length; index += 1) {
      byteArray[index] = binaryString.charCodeAt(index);
    }
    return byteArray.buffer;
  }

  if (!contentType.toLowerCase().startsWith('audio/')) {
    const preview = new TextDecoder().decode(arrayBuffer.slice(0, 200));
    throw new Error(
      `TTS (local) devolvió content-type inesperado '${contentType}': ${preview.slice(0, 120)}`,
    );
  }
  if (
    contentType.toLowerCase().includes('audio/wav') ||
    contentType.toLowerCase().includes('audio/x-wav')
  ) {
    throw new Error(
      `TTS (local) devolvió WAV pero se solicitó PCM (content-type: ${contentType})`,
    );
  }
  const rateMatch = /rate=(\d+)/i.exec(contentType);
  if (rateMatch !== null) {
    const sampleRateHz = Number.parseInt(rateMatch[1], 10);
    if (sampleRateHz !== DEVICE_PCM_SAMPLE_RATE_HZ) {
      throw new Error(
        `TTS (local) devolvió ${sampleRateHz}Hz; el dispositivo requiere ${DEVICE_PCM_SAMPLE_RATE_HZ}Hz (content-type: ${contentType})`,
      );
    }
  }

  return arrayBuffer;
}
