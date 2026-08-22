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

describe('light_status argument tolerance', () => {
  it('treats null/empty room and missing args as whole-house', async () => {
    const restore = installFakeHueFetch();
    try {
      for (const args of [
        undefined,
        null,
        {},
        { room: null },
        { room: '' },
        { room: '  ' },
      ]) {
        const result = await lightStatusTool.handler(args, createLinkedContext());
        expect(result.summary).toBe('Encendidas: Lámpara al 80%.');
      }
    } finally {
      restore();
    }
  });
});

import { createBuiltinToolDefinitionMap } from '@/tools/catalog';
import { setLightTool, setSceneTool } from '@/tools/home';
import { executeToolByName } from '@/tools/router';

const SCENES = {
  data: [
    {
      id: 'sc-living-bright',
      metadata: { name: 'Bright' },
      group: { rid: 'room-living', rtype: 'room' },
    },
    {
      id: 'sc-bed-bright',
      metadata: { name: 'Bright' },
      group: { rid: 'room-bed', rtype: 'room' },
    },
  ],
};

function installRecordingHueFetch(): {
  restore: () => void;
  writes: () => readonly { url: string; body: unknown }[];
} {
  const original = globalThis.fetch;
  const writes: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === 'PUT') {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ data: [] });
    }
    if (url.endsWith('/resource/room')) return Response.json(ROOMS);
    if (url.endsWith('/resource/light')) return Response.json(LIGHTS);
    if (url.endsWith('/resource/scene')) return Response.json(SCENES);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    writes: () => writes,
  };
}

describe('set_light', () => {
  it('is unsafe: an unconfirmed call mutates nothing and asks for confirmation', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      const outcome = await executeToolByName(
        createBuiltinToolDefinitionMap(),
        'set_light',
        { room: 'Living', on: false },
        createLinkedContext(),
      );
      expect(outcome.status).toBe('needs_confirm');
      expect(outcome.status === 'needs_confirm' && outcome.pending.summary).toBe(
        '¿Apago las luces de Living?',
      );
      expect(writes()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('writes the room grouped_light once confirmed', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      const result = await setLightTool.handler(
        { room: 'living', on: true, brightness: 40 },
        createLinkedContext(),
      );
      expect(result).toEqual({ ok: true, summary: 'Luces de Living encendidas.' });
      expect(writes()).toEqual([
        {
          url: 'https://api.meethue.com/route/clip/v2/resource/grouped_light/gl-1',
          body: { on: { on: true }, dimming: { brightness: 40 } },
        },
      ]);
    } finally {
      restore();
    }
  });

  it('fails closed on an unknown room without writing', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      const result = await setLightTool.handler(
        { room: 'garage', on: false },
        createLinkedContext(),
      );
      expect(result).toEqual({
        ok: false,
        summary: 'No encuentro la habitación garage.',
      });
      expect(writes()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('has no whole-house form: room is required by schema', () => {
    expect(() => setLightTool.buildConfirmSummary?.({ on: false })).toThrow();
  });
});

describe('set_scene', () => {
  it('recalls the scene belonging to the named room, not a same-named one elsewhere', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      const result = await setSceneTool.handler(
        { room: 'Dormitorio', scene: 'bright' },
        createLinkedContext(),
      );
      expect(result.ok).toBe(true);
      expect(writes()).toEqual([
        {
          url: 'https://api.meethue.com/route/clip/v2/resource/scene/sc-bed-bright',
          body: { recall: { action: 'active' } },
        },
      ]);
    } finally {
      restore();
    }
  });

  it('fails closed when the room lacks the scene and lists what it has', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      const result = await setSceneTool.handler(
        { room: 'Living', scene: 'Relax' },
        createLinkedContext(),
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('Tiene: Bright');
      expect(writes()).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('spoken-argument tolerance', () => {
  it('matches a room said in English, with spaces or accents', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      for (const room of [
        'living room',
        'The Living Room',
        'living lights',
        'las luces del Living',
      ]) {
        const result = await setLightTool.handler(
          { room, on: true },
          createLinkedContext(),
        );
        expect(result).toEqual({ ok: true, summary: 'Luces de Living encendidas.' });
      }
      expect(writes()).toHaveLength(4);
    } finally {
      restore();
    }
  });

  it('accepts on as a string or number instead of throwing', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      for (const on of ['true', 'off', 1, 0, 'apagar']) {
        const result = await setLightTool.handler(
          { room: 'Living', on },
          createLinkedContext(),
        );
        expect(result.ok).toBe(true);
      }
      expect(writes()).toHaveLength(5);
    } finally {
      restore();
    }
  });

  it('returns a spoken failure (never throws) on unusable arguments', async () => {
    const { restore, writes } = installRecordingHueFetch();
    try {
      const result = await setLightTool.handler({ on: 'maybe' }, createLinkedContext());
      expect(result.ok).toBe(false);
      expect(writes()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('asks the confirmation as a question', () => {
    expect(setLightTool.buildConfirmSummary?.({ room: 'Tvlights', on: true })).toBe(
      '¿Enciendo las luces de Tvlights?',
    );
    expect(setLightTool.buildConfirmSummary?.({ room: 'Living', on: false })).toBe(
      '¿Apago las luces de Living?',
    );
  });
});

describe('tool router isolation', () => {
  it('turns a throwing handler into a tool failure instead of failing the turn', async () => {
    const throwingTool = {
      name: 'boom',
      safety: 'safe' as const,
      description: 'x',
      parameters: {},
      handler: async () => {
        throw new Error('kaboom');
      },
    };
    const outcome = await executeToolByName(
      new Map([[throwingTool.name, throwingTool]]),
      'boom',
      {},
      createLinkedContext(),
    );
    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' && outcome.result.ok).toBe(false);
    expect(outcome.status === 'done' && outcome.result.summary).toContain('kaboom');
  });
});
