import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import {
  GOOGLE_TOKEN_KV_KEY,
  exchangeGoogleAuthorizationCode,
  refreshGoogleTokens,
} from '@/google/oauth';
import { handleGoogleOauthRequest } from '@/google/routes';

const HOUR_MILLISECONDS = 60 * 60 * 1000;

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

function createTokenFetch(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

describe('google oauth token handling', () => {
  const nowMilliseconds = Date.parse('2026-08-24T12:00:00Z');

  it('rejects an authorization exchange that returns no refresh token', async () => {
    const environment = createFakeApolloEnvironment({
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_TOKENS: createFakeKv(),
    });

    await expect(
      exchangeGoogleAuthorizationCode(
        environment,
        'auth-code',
        'https://apollo.example/oauth/google/callback',
        nowMilliseconds,
        createTokenFetch({ access_token: 'a', expires_in: 3600 }),
      ),
    ).rejects.toThrow('no refresh token');
  });

  // Google omits refresh_token from refresh responses. Overwriting the stored
  // record with the response alone would erase the only long-lived credential.
  it('keeps the existing refresh token when the refresh response omits it', async () => {
    const tokens = createFakeKv({
      [GOOGLE_TOKEN_KV_KEY]: JSON.stringify({
        accessToken: 'old-access',
        refreshToken: 'long-lived-refresh',
        expiresAtMilliseconds: nowMilliseconds,
      }),
    });
    const environment = createFakeApolloEnvironment({
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_TOKENS: tokens,
    });

    const refreshed = await refreshGoogleTokens(
      environment,
      {
        accessToken: 'old-access',
        refreshToken: 'long-lived-refresh',
        expiresAtMilliseconds: nowMilliseconds,
      },
      nowMilliseconds,
      createTokenFetch({ access_token: 'new-access', expires_in: 3600 }),
    );

    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('long-lived-refresh');
    expect(refreshed.expiresAtMilliseconds).toBe(nowMilliseconds + HOUR_MILLISECONDS);

    const persisted = JSON.parse(tokens.store.get(GOOGLE_TOKEN_KV_KEY) ?? '{}');
    expect(persisted.refreshToken).toBe('long-lived-refresh');
  });
});

describe('google oauth routes', () => {
  it('404s every route while GOOGLE_OAUTH_ENABLED is unset', async () => {
    const response = await handleGoogleOauthRequest(
      new URL('https://apollo.example/oauth/google/start'),
      createFakeApolloEnvironment({ GOOGLE_TOKENS: createFakeKv() }),
    );

    expect(response.status).toBe(404);
  });

  it('401s /start without the dashboard secret', async () => {
    const response = await handleGoogleOauthRequest(
      new URL('https://apollo.example/oauth/google/start'),
      createFakeApolloEnvironment({
        GOOGLE_OAUTH_ENABLED: '1',
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_TOKENS: createFakeKv(),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a callback whose state nonce is unknown', async () => {
    const response = await handleGoogleOauthRequest(
      new URL('https://apollo.example/oauth/google/callback?code=abc&state=never-issued'),
      createFakeApolloEnvironment({
        GOOGLE_OAUTH_ENABLED: '1',
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_TOKENS: createFakeKv(),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('unknown or expired state');
  });

  it('asks Google for offline access, or the link lasts one hour', async () => {
    const environment = createFakeApolloEnvironment({
      GOOGLE_OAUTH_ENABLED: '1',
      GOOGLE_CLIENT_ID: 'client-id',
      DASHBOARD_SHARED_SECRET: 'dashboard-secret',
      GOOGLE_TOKENS: createFakeKv(),
    });

    const response = await handleGoogleOauthRequest(
      new URL('https://apollo.example/oauth/google/start?token=dashboard-secret'),
      environment,
    );

    expect(response.status).toBe(302);
    const authorizeUrl = new URL(response.headers.get('location') ?? '');
    expect(authorizeUrl.searchParams.get('access_type')).toBe('offline');
    expect(authorizeUrl.searchParams.get('prompt')).toBe('consent');
    expect(authorizeUrl.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.events',
    );
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'https://apollo.example/oauth/google/callback',
    );
  });
});
