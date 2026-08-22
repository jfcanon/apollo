import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import {
  HUE_APP_KEY_KV_KEY,
  HUE_TOKEN_KV_KEY,
  HUE_TOKEN_URL,
  bootstrapHueApplicationKey,
  hueFetch,
} from '@/home/hue';
import { handleHueOauthRequest } from '@/home/oauth';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

function createFakeKv(initial: Record<string, string> = {}): KVNamespace & {
  readonly store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key: string, type?: unknown) => {
      const value = store.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { readonly store: Map<string, string> };
}

function createFetchRecorder(respond: (url: string, init?: RequestInit) => Response): {
  fetchImplementation: typeof fetch;
  readCalls: () => readonly { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetchImplementation, readCalls: () => calls };
}

function createLinkedEnvironment(expiresAtMilliseconds: number): Env {
  return createFakeApolloEnvironment({
    HUE_CLIENT_ID: 'client',
    HUE_CLIENT_SECRET: 'secret',
    HUE_TOKENS: createFakeKv({
      [HUE_APP_KEY_KV_KEY]: 'app-key',
      [HUE_TOKEN_KV_KEY]: JSON.stringify({
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAtMilliseconds,
      }),
    }),
  });
}

describe('hueFetch', () => {
  it('fails closed without client credentials and performs no request', async () => {
    const { fetchImplementation, readCalls } = createFetchRecorder(
      () => new Response('{}'),
    );
    const environment = createFakeApolloEnvironment({ HUE_TOKENS: createFakeKv() });
    const result = await hueFetch(environment, '/route/clip/v2/resource/light', {
      fetchImplementation,
    });
    expect(result).toEqual({ ok: false, error: 'hue client credentials missing' });
    expect(readCalls()).toEqual([]);
  });

  it('fails closed when not linked', async () => {
    const { fetchImplementation, readCalls } = createFetchRecorder(
      () => new Response('{}'),
    );
    const environment = createFakeApolloEnvironment({
      HUE_CLIENT_ID: 'client',
      HUE_CLIENT_SECRET: 'secret',
      HUE_TOKENS: createFakeKv({ [HUE_APP_KEY_KV_KEY]: 'app-key' }),
    });
    const result = await hueFetch(environment, '/route/clip/v2/resource/light', {
      fetchImplementation,
    });
    expect(result.ok).toBe(false);
    expect(readCalls()).toEqual([]);
  });

  it('attaches bearer and application key when the token is fresh', async () => {
    const { fetchImplementation, readCalls } = createFetchRecorder(
      () => new Response('{"data":[]}'),
    );
    const environment = createLinkedEnvironment(10 * DAY_MILLISECONDS);
    const result = await hueFetch(environment, '/route/clip/v2/resource/light', {
      nowMilliseconds: 0,
      fetchImplementation,
    });
    expect(result.ok).toBe(true);
    const [call] = readCalls();
    expect(call?.url).toBe('https://api.meethue.com/route/clip/v2/resource/light');
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-old');
    expect(headers.get('hue-application-key')).toBe('app-key');
  });

  it('refreshes once when the token is about to expire, then uses the new token', async () => {
    const { fetchImplementation, readCalls } = createFetchRecorder((url) =>
      url === HUE_TOKEN_URL
        ? Response.json({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 604800,
          })
        : new Response('{"data":[]}'),
    );
    const environment = createLinkedEnvironment(DAY_MILLISECONDS / 2);
    const result = await hueFetch(environment, '/route/clip/v2/resource/light', {
      nowMilliseconds: 0,
      fetchImplementation,
    });
    expect(result.ok).toBe(true);
    const calls = readCalls();
    expect(calls.map((call) => call.url)).toEqual([
      HUE_TOKEN_URL,
      'https://api.meethue.com/route/clip/v2/resource/light',
    ]);
    expect(String(calls[0]?.init?.body)).toContain('grant_type=refresh_token');
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe(
      'Bearer access-new',
    );
    const stored = JSON.parse(
      (environment.HUE_TOKENS as unknown as { store: Map<string, string> }).store.get(
        HUE_TOKEN_KV_KEY,
      ) ?? '{}',
    );
    expect(stored.refreshToken).toBe('refresh-new');
  });

  it('returns an error (no retry storm) when the refresh fails', async () => {
    const { fetchImplementation, readCalls } = createFetchRecorder(
      () => new Response('nope', { status: 401 }),
    );
    const environment = createLinkedEnvironment(0);
    const result = await hueFetch(environment, '/route/clip/v2/resource/light', {
      nowMilliseconds: 0,
      fetchImplementation,
    });
    expect(result).toEqual({ ok: false, error: 'hue token endpoint returned 401' });
    expect(readCalls()).toHaveLength(1);
  });
});

describe('bootstrapHueApplicationKey', () => {
  it('presses the link button, registers, and stores the application key', async () => {
    const { fetchImplementation, readCalls } = createFetchRecorder((url) =>
      url.endsWith('/route/api')
        ? Response.json([{ success: { username: 'generated-key' } }])
        : Response.json([{ success: { '/config/linkbutton': true } }]),
    );
    const kv = createFakeKv({
      [HUE_TOKEN_KV_KEY]: JSON.stringify({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAtMilliseconds: 1,
      }),
    });
    const environment = createFakeApolloEnvironment({
      HUE_CLIENT_ID: 'client',
      HUE_CLIENT_SECRET: 'secret',
      HUE_TOKENS: kv,
    });
    const result = await bootstrapHueApplicationKey(environment, fetchImplementation);
    expect(result).toEqual({ ok: true });
    expect(readCalls().map((call) => call.init?.method)).toEqual(['PUT', 'POST']);
    expect(kv.store.get(HUE_APP_KEY_KV_KEY)).toBe('generated-key');
  });
});

describe('handleHueOauthRequest', () => {
  it('is invisible (404) unless HUE_OAUTH_ENABLED=1', async () => {
    const environment = createFakeApolloEnvironment({ HUE_CLIENT_ID: 'client' });
    const response = await handleHueOauthRequest(
      new URL('https://apollo.test/oauth/hue/start?token=dashboard-secret'),
      environment,
    );
    expect(response.status).toBe(404);
  });

  it('rejects /start without the dashboard secret', async () => {
    const environment = createFakeApolloEnvironment({ HUE_OAUTH_ENABLED: '1' });
    const response = await handleHueOauthRequest(
      new URL('https://apollo.test/oauth/hue/start'),
      environment,
    );
    expect(response.status).toBe(401);
  });

  it('redirects /start to Hue with a stored state nonce', async () => {
    const kv = createFakeKv();
    const environment = createFakeApolloEnvironment({
      HUE_OAUTH_ENABLED: '1',
      HUE_CLIENT_ID: 'client',
      HUE_TOKENS: kv,
    });
    const response = await handleHueOauthRequest(
      new URL('https://apollo.test/oauth/hue/start?token=dashboard-secret'),
      environment,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(
      'https://api.meethue.com/v2/oauth2/authorize',
    );
    expect(location.searchParams.get('client_id')).toBe('client');
    const state = location.searchParams.get('state') ?? '';
    expect(kv.store.has(`oauth-state:${state}`)).toBe(true);
  });

  it('rejects a callback with an unknown state', async () => {
    const environment = createFakeApolloEnvironment({
      HUE_OAUTH_ENABLED: '1',
      HUE_CLIENT_ID: 'client',
      HUE_CLIENT_SECRET: 'secret',
      HUE_TOKENS: createFakeKv(),
    });
    const response = await handleHueOauthRequest(
      new URL('https://apollo.test/oauth/hue/callback?code=abc&state=forged'),
      environment,
    );
    expect(response.status).toBe(400);
  });
});
