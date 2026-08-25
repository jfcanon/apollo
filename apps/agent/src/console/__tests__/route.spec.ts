import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { buildConsolePageHtml } from '@/console/page';
import { CONSOLE_PATH, handleConsoleRequest } from '@/console/route';

describe('console route', () => {
  it('refuses without the dashboard secret', async () => {
    const response = await handleConsoleRequest(
      new URL(`https://apollo.test${CONSOLE_PATH}`),
      createFakeApolloEnvironment(),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const response = await handleConsoleRequest(
      new URL(`https://apollo.test${CONSOLE_PATH}?token=nope`),
      createFakeApolloEnvironment(),
    );
    expect(response.status).toBe(401);
  });

  it('serves an uncacheable html page with the right token', async () => {
    const response = await handleConsoleRequest(
      new URL(`https://apollo.test${CONSOLE_PATH}?token=dashboard-secret`),
      createFakeApolloEnvironment(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<title>Jarvis</title>');
  });
});

describe('console page', () => {
  const html = buildConsolePageHtml();

  it('speaks the device protocol the firmware speaks', () => {
    for (const frameType of [
      'hello',
      'wake',
      'audio_end',
      'abort',
      'confirm',
      'playback_ack',
    ]) {
      expect(html).toContain(`'${frameType}'`);
    }
    for (const serverFrame of [
      'tts_start',
      'tts_end',
      'turn_end',
      'confirm_request',
      'ui_state',
    ]) {
      expect(html).toContain(serverFrame);
    }
  });

  it('captures at the rate the server expects and plays at the TTS rate', () => {
    // The server wraps mic audio as 16 kHz PCM16 (DEVICE_MIC_PCM_SAMPLE_RATE_HZ)
    // and the providers emit 24 kHz; a mismatch here is chipmunk audio.
    expect(html).toContain('const MIC_RATE = 16000');
    expect(html).toContain('const TTS_RATE = 24000');
  });

  it('reopens the microphone after a turn ends, which is what makes it a dialogue', () => {
    expect(html).toContain("case 'turn_end'");
    expect(html).toContain('armListening()');
  });

  it('never carries a secret in the page itself', () => {
    expect(html).not.toContain('dashboard-secret');
    expect(html).toContain('localStorage');
  });
});
