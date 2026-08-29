import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import { parseDeviceToServerMessage } from '@/protocol/schema';
import type { DeviceToServerMessage } from '@/protocol/schema';

// The Mac listener (apps/mac-listener) is Python, so it cannot import this
// schema. Instead its own test suite writes every frame it can emit to a golden
// fixture, and this test parses that fixture with the real schema. A builder
// that drifts from the contract fails on one side or the other.
//
// Regenerate after an intentional protocol change:
//   cd apps/mac-listener && UPDATE_GOLDEN=1 pytest tests/test_protocol.py
const goldenFixturePath = fileURLToPath(
  new URL('../../../../mac-listener/tests/fixtures/frames.golden.json', import.meta.url)
    .href,
);

const goldenFrameList = JSON.parse(
  readFileSync(goldenFixturePath, 'utf8'),
) as readonly unknown[];

const REQUIRED_TYPE_LIST = [
  'hello',
  'wake',
  'audio_end',
  'listen_cancel',
  'abort',
  'playback_ack',
  'telemetry',
] as const satisfies readonly DeviceToServerMessage['type'][];

describe('mac listener protocol contract', () => {
  it('ships a non-empty fixture', () => {
    expect(goldenFrameList.length).toBeGreaterThan(0);
  });

  it('every frame the listener emits satisfies the device schema', () => {
    for (const frame of goldenFrameList) {
      expect(() => parseDeviceToServerMessage(frame)).not.toThrow();
    }
  });

  it('covers the frames the listen loop depends on', () => {
    const emittedTypeSet = new Set(
      goldenFrameList.map((frame) => parseDeviceToServerMessage(frame).type),
    );
    for (const requiredType of REQUIRED_TYPE_LIST) {
      expect(emittedTypeSet).toContain(requiredType);
    }
  });

  it('identifies itself as mac-listener so telemetry separates it from the ESP32', () => {
    const helloMessage = parseDeviceToServerMessage(goldenFrameList[0]);
    expect(helloMessage.type).toBe('hello');
    if (helloMessage.type === 'hello') {
      expect(helloMessage.deviceId).toBe('mac-listener');
    }
  });

  it('stamps ts in epoch seconds, not milliseconds', () => {
    // Milliseconds would still satisfy the schema and silently skew every
    // server-side freshness comparison, so the fixture pins the magnitude.
    for (const frame of goldenFrameList) {
      const { ts } = parseDeviceToServerMessage(frame);
      expect(ts).toBeGreaterThan(1_000_000_000);
      expect(ts).toBeLessThan(10_000_000_000);
    }
  });
});
