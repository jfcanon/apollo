import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { HUE_APP_KEY_KV_KEY, HUE_TOKEN_KV_KEY } from '@/home/hue';
import { lightStatusTool, listRoomsTool } from '@/tools/home';
import type { ToolExecutionContext } from '@/tools/types';

const ROOMS = {
  data: [
    {
      id: 'room-living',
      metadata: { name: 'Living' },
      children: [
        { rid: 'dev-1', rtype: 'device' },
        { rid: 'dev-2', rtype: 'device' },
      ],
      services: [{ rid: 'gl-1', rtype: 'grouped_light' }],
    },
    {
      id: 'room-bed',
      metadata: { name: 'Dormitorio' },
      children: [{ rid: 'dev-3', rtype: 'device' }],
      services: [],
    },
  ],
};
const LIGHTS = {
  data: [
    {
      id: 'l-1',
      metadata: { name: 'Lámpara' },
      on: { on: true },
      dimming: { brightness: 80 },
      owner: { rid: 'dev-1' },
    },
    {
      id: 'l-2',
      metadata: { name: 'Techo' },
      on: { on: false },
      owner: { rid: 'dev-2' },
    },
    {
      id: 'l-3',
      metadata: { name: 'Velador' },
      on: { on: false },
      owner: { rid: 'dev-3' },
    },
  ],
};

function createLinkedContext(): ToolExecutionContext {
  const store = new Map<string, string>([
    [HUE_APP_KEY_KV_KEY, 'app-key'],
    [
      HUE_TOKEN_KV_KEY,
      JSON.stringify({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAtMilliseconds: 9e15,
      }),
    ],
  ]);
  const kv = {
    get: async (key: string, type?: unknown) => {
      const value = store.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;
  return {
    environment: createFakeApolloEnvironment({
      HUE_CLIENT_ID: 'c',
      HUE_CLIENT_SECRET: 's',
      HUE_TOKENS: kv,
    }),
    nowMilliseconds: 0,
  };
}

function installFakeHueFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/resource/room')) return Response.json(ROOMS);
    if (url.endsWith('/resource/light')) return Response.json(LIGHTS);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('list_rooms', () => {
  it('names each room with its on/total light count', async () => {
    const restore = installFakeHueFetch();
    try {
      const result = await listRoomsTool.handler({}, createLinkedContext());
      expect(result.ok).toBe(true);
      expect(result.summary).toBe(
        'Habitaciones: Living (1 de 2 encendidas), Dormitorio (0 de 1 encendidas).',
      );
    } finally {
      restore();
    }
  });

  it('fails closed (spoken error, no crash) when hue is not configured', async () => {
    const result = await listRoomsTool.handler(
      {},
      { environment: createFakeApolloEnvironment(), nowMilliseconds: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('hue client credentials missing');
  });
});

describe('light_status', () => {
  it('lists only the lights that are on, house-wide', async () => {
    const restore = installFakeHueFetch();
    try {
      const result = await lightStatusTool.handler({}, createLinkedContext());
      expect(result).toMatchObject({ ok: true, summary: 'Encendidas: Lámpara al 80%.' });
    } finally {
      restore();
    }
  });

  it('describes every light of a named room (case-insensitive)', async () => {
    const restore = installFakeHueFetch();
    try {
      const result = await lightStatusTool.handler(
        { room: 'living' },
        createLinkedContext(),
      );
      expect(result.summary).toBe('Living: Lámpara al 80%, Techo apagada.');
    } finally {
      restore();
    }
  });

  it('fails closed on an unknown room', async () => {
    const restore = installFakeHueFetch();
    try {
      const result = await lightStatusTool.handler(
        { room: 'garage' },
        createLinkedContext(),
      );
      expect(result).toEqual({
        ok: false,
        summary: 'No encuentro la habitación garage.',
      });
    } finally {
      restore();
    }
  });
});
