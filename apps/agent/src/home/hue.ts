// Hue Remote API client. The Worker talks ONLY to api.meethue.com — the same
// cloud the Hue app uses on 4G — never to the bridge IP. Nothing Hue-related
// lives on the Mac or the Lima VM. Mirrors src/brain/proxy.ts: FAIL CLOSED when
// any credential is missing, never send a half-authenticated request.

export const HUE_API_BASE_URL = 'https://api.meethue.com';
export const HUE_TOKEN_URL = `${HUE_API_BASE_URL}/v2/oauth2/token`;
export const HUE_AUTHORIZE_URL = `${HUE_API_BASE_URL}/v2/oauth2/authorize`;

export const HUE_TOKEN_KV_KEY = 'oauth-tokens';
export const HUE_APP_KEY_KV_KEY = 'application-key';
// Refresh when this much lifetime is left (access tokens live ~7 days).
const REFRESH_MARGIN_MILLISECONDS = 24 * 60 * 60 * 1000;

export type HueTokenRecord = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtMilliseconds: number;
};

export type HueFetchResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: string };

type HueCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokens: KVNamespace;
};

function readHueCredentials(environment: Env): HueCredentials | null {
  const clientId = environment.HUE_CLIENT_ID;
  const clientSecret = environment.HUE_CLIENT_SECRET;
  const tokens = environment.HUE_TOKENS;
  if (!clientId || !clientSecret || !tokens) {
    return null;
  }
  return { clientId, clientSecret, tokens };
}

export function isHueConfigured(environment: Env): boolean {
  return readHueCredentials(environment) !== null;
}

function buildBasicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

type HueTokenResponse = {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
};

async function requestHueTokens(
  credentials: HueCredentials,
  body: URLSearchParams,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch,
): Promise<HueTokenRecord> {
  const response = await fetchImplementation(HUE_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: buildBasicAuthorization(
        credentials.clientId,
        credentials.clientSecret,
      ),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`hue token endpoint returned ${response.status}`);
  }
  const payload = (await response.json()) as Partial<HueTokenResponse>;
  if (!payload.access_token || !payload.refresh_token || !payload.expires_in) {
    throw new Error('hue token endpoint returned an incomplete payload');
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMilliseconds: nowMilliseconds + payload.expires_in * 1000,
  };
}

// One-time: authorization code (from the OAuth callback) -> token pair.
export async function exchangeHueAuthorizationCode(
  environment: Env,
  code: string,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch = fetch,
): Promise<HueTokenRecord> {
  const credentials = readHueCredentials(environment);
  if (credentials === null) {
    throw new Error('hue client credentials missing');
  }
  const tokens = await requestHueTokens(
    credentials,
    new URLSearchParams({ grant_type: 'authorization_code', code }),
    nowMilliseconds,
    fetchImplementation,
  );
  await credentials.tokens.put(HUE_TOKEN_KV_KEY, JSON.stringify(tokens));
  return tokens;
}

export async function readHueTokens(environment: Env): Promise<HueTokenRecord | null> {
  const tokens = environment.HUE_TOKENS;
  if (!tokens) {
    return null;
  }
  return tokens.get<HueTokenRecord>(HUE_TOKEN_KV_KEY, 'json');
}

// Single-flight refresh: concurrent callers share one in-flight refresh so a
// burst of tool calls cannot spend the refresh token twice.
let inFlightRefresh: Promise<HueTokenRecord> | null = null;

async function refreshHueTokens(
  credentials: HueCredentials,
  current: HueTokenRecord,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch,
): Promise<HueTokenRecord> {
  if (inFlightRefresh === null) {
    inFlightRefresh = requestHueTokens(
      credentials,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      }),
      nowMilliseconds,
      fetchImplementation,
    )
      .then(async (refreshed) => {
        await credentials.tokens.put(HUE_TOKEN_KV_KEY, JSON.stringify(refreshed));
        return refreshed;
      })
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

async function resolveAccessToken(
  environment: Env,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch,
): Promise<{ readonly accessToken: string; readonly applicationKey: string } | string> {
  const credentials = readHueCredentials(environment);
  if (credentials === null) {
    return 'hue client credentials missing';
  }
  const applicationKey = await credentials.tokens.get(HUE_APP_KEY_KV_KEY);
  if (!applicationKey) {
    return 'hue application key missing (run the OAuth bootstrap)';
  }
  const stored = await credentials.tokens.get<HueTokenRecord>(HUE_TOKEN_KV_KEY, 'json');
  if (stored === null) {
    return 'hue not linked (run the OAuth bootstrap)';
  }
  const needsRefresh =
    stored.expiresAtMilliseconds - nowMilliseconds < REFRESH_MARGIN_MILLISECONDS;
  if (!needsRefresh) {
    return { accessToken: stored.accessToken, applicationKey };
  }
  const refreshed = await refreshHueTokens(
    credentials,
    stored,
    nowMilliseconds,
    fetchImplementation,
  );
  return { accessToken: refreshed.accessToken, applicationKey };
}

// Authenticated call against the Remote API. `path` is relative to
// api.meethue.com, e.g. "/route/clip/v2/resource/light".
export async function hueFetch(
  environment: Env,
  path: string,
  init: RequestInit & {
    readonly nowMilliseconds?: number;
    readonly fetchImplementation?: typeof fetch;
  } = {},
): Promise<HueFetchResult> {
  const {
    nowMilliseconds = Date.now(),
    fetchImplementation = fetch,
    ...requestInit
  } = init;
  try {
    const resolved = await resolveAccessToken(
      environment,
      nowMilliseconds,
      fetchImplementation,
    );
    if (typeof resolved === 'string') {
      return { ok: false, error: resolved };
    }
    const headers = new Headers(requestInit.headers);
    headers.set('authorization', `Bearer ${resolved.accessToken}`);
    headers.set('hue-application-key', resolved.applicationKey);
    if (requestInit.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetchImplementation(
      new URL(path, HUE_API_BASE_URL).toString(),
      {
        ...requestInit,
        headers,
      },
    );
    return { ok: true, response };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'hue unreachable',
    };
  }
}

// One-time, right after the OAuth link: press the virtual link button through
// the cloud, then register an application to obtain the hue-application-key.
// Only the bearer token is needed here (no application key yet).
export async function bootstrapHueApplicationKey(
  environment: Env,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const credentials = readHueCredentials(environment);
  if (credentials === null) {
    return { ok: false, error: 'hue client credentials missing' };
  }
  const stored = await credentials.tokens.get<HueTokenRecord>(HUE_TOKEN_KV_KEY, 'json');
  if (stored === null) {
    return { ok: false, error: 'hue not linked' };
  }
  const bearer = {
    authorization: `Bearer ${stored.accessToken}`,
    'content-type': 'application/json',
  };
  const linkResponse = await fetchImplementation(
    `${HUE_API_BASE_URL}/route/api/0/config`,
    {
      method: 'PUT',
      headers: bearer,
      body: JSON.stringify({ linkbutton: true }),
    },
  );
  if (!linkResponse.ok) {
    return { ok: false, error: `linkbutton returned ${linkResponse.status}` };
  }
  const registerResponse = await fetchImplementation(`${HUE_API_BASE_URL}/route/api`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({ devicetype: 'jarvis#apollo' }),
  });
  if (!registerResponse.ok) {
    return { ok: false, error: `register returned ${registerResponse.status}` };
  }
  const payload = (await registerResponse.json()) as readonly {
    readonly success?: { readonly username?: string };
    readonly error?: { readonly description?: string };
  }[];
  const username = payload[0]?.success?.username;
  if (!username) {
    return {
      ok: false,
      error: payload[0]?.error?.description ?? 'no application key returned',
    };
  }
  await credentials.tokens.put(HUE_APP_KEY_KV_KEY, username);
  return { ok: true };
}
