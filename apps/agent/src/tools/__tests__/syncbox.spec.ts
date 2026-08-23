import { describe, expect, it } from 'bun:test';

import {
  createFakeApolloEnvironment,
  createStubDeskToolEffects,
} from '@/configuration/testing';
import {
  SYNC_BOX_SET_MODE_TOOL_NAME,
  SYNC_BOX_SET_SOURCE_TOOL_NAME,
  SYNC_BOX_SET_SYNC_TOOL_NAME,
  SYNC_BOX_STATUS_TOOL_NAME,
  syncBoxSetModeTool,
  syncBoxSetSourceTool,
  syncBoxSetSyncTool,
  syncBoxStatusTool,
} from '@/tools/syncbox';
import type { ToolExecutionContext } from '@/tools/types';

function createContext(deviceResponse = { ok: true, summary: 'ok' }): {
  context: ToolExecutionContext;
  readCalls: () => readonly {
    deviceToolName: string;
    argumentRecord: Record<string, unknown>;
  }[];
} {
  const calls: { deviceToolName: string; argumentRecord: Record<string, unknown> }[] = [];
  return {
    context: {
      environment: createFakeApolloEnvironment(),
      nowMilliseconds: 0,
      effects: createStubDeskToolEffects({
        callDeviceTool: async (input) => {
          calls.push(input);
          return deviceResponse;
        },
      }),
    },
    readCalls: () => calls,
  };
}

describe('sync box tools', () => {
  it('reads status through the device, never the cloud', async () => {
    const { context, readCalls } = createContext({
      ok: true,
      summary: 'syncing, mode video, source input2',
    });
    const result = await syncBoxStatusTool.handler({}, context);
    expect(result).toMatchObject({
      ok: true,
      summary: 'Sync Box: syncing, mode video, source input2',
    });
    expect(readCalls()).toEqual([
      { deviceToolName: SYNC_BOX_STATUS_TOOL_NAME, argumentRecord: {} },
    ]);
  });

  it('accepts a spoken on value and forwards a real boolean', async () => {
    const { context, readCalls } = createContext();
    const result = await syncBoxSetSyncTool.handler({ on: 'prender' }, context);
    expect(result.ok).toBe(true);
    expect(readCalls()).toEqual([
      { deviceToolName: SYNC_BOX_SET_SYNC_TOOL_NAME, argumentRecord: { on: true } },
    ]);
  });

  it('forwards a valid mode and refuses an invalid one without calling the device', async () => {
    const { context, readCalls } = createContext();
    expect((await syncBoxSetModeTool.handler({ mode: 'game' }, context)).ok).toBe(true);
    const bad = await syncBoxSetModeTool.handler({ mode: 'cinema' }, context);
    expect(bad.ok).toBe(false);
    expect(readCalls()).toEqual([
      { deviceToolName: SYNC_BOX_SET_MODE_TOOL_NAME, argumentRecord: { mode: 'game' } },
    ]);
  });

  it('switches HDMI input', async () => {
    const { context, readCalls } = createContext();
    await syncBoxSetSourceTool.handler({ source: 'input1' }, context);
    expect(readCalls()).toEqual([
      {
        deviceToolName: SYNC_BOX_SET_SOURCE_TOOL_NAME,
        argumentRecord: { source: 'input1' },
      },
    ]);
  });

  it('reports a device failure as a spoken error, not a throw', async () => {
    const { context } = createContext({
      ok: false,
      summary: 'no Sync Box address configured',
    });
    const result = await syncBoxSetSyncTool.handler({ on: true }, context);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('no Sync Box address configured');
  });

  it('every mutation is confirmation-gated', () => {
    for (const tool of [syncBoxSetSyncTool, syncBoxSetModeTool, syncBoxSetSourceTool]) {
      expect(tool.safety).toBe('unsafe');
    }
    expect(syncBoxStatusTool.safety).toBe('safe');
  });
});
