// Google OAuth for the Apollo desk agent. Mirrors src/home/hue.ts: the Worker
// holds the only copy of the credentials, and every path FAILS CLOSED rather
// than sending a half-authenticated request.
//
// Two ways Google differs from Hue, both load-bearing:
//   1. The token endpoint takes client_id/client_secret in the form body, not
//      a Basic authorization header.
//   2. A refresh response does NOT echo refresh_token. Overwriting the stored
//      record with the response alone would erase the only long-lived
//      credential and require a human at a browser to recover.
export const GOOGLE_API_BASE_URL = 'https://www.googleapis.com';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_TOKEN_KV_KEY = 'oauth-tokens';

// Minimum for read + write of events. Deliberately NOT calendar.readonly (no
// writes) and NOT the full calendar scope (would also grant calendar deletion).
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Google access tokens live ~1h; refresh with 5 minutes to spare so a turn that
// starts just under the wire does not expire mid-request.
const REFRESH_MARGIN_MILLISECONDS = 5 * 60 * 1000;

export type GoogleTokenRecord = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtMilliseconds: number;
};

export type GoogleFetchResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: string };

type GoogleCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokens: KVNamespace;
};

function readGoogleCredentials(environment: Env): GoogleCredentials | null {
  const clientId = environment.GOOGLE_CLIENT_ID;
  const clientSecret = environment.GOOGLE_CLIENT_SECRET;
  const tokens = environment.GOOGLE_TOKENS;
  if (!clientId || !clientSecret || !tokens) {
    return null;
  }
  return { clientId, clientSecret, tokens };
}

export function isGoogleConfigured(environment: Env): boolean {
  return readGoogleCredentials(environment) !== null;
}

export function buildGoogleRedirectUri(requestUrl: URL): string {
  return new URL('/oauth/google/callback', requestUrl.origin).toString();
}

type GoogleTokenResponse = {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
};

async function requestGoogleTokens(
  credentials: GoogleCredentials,
  body: URLSearchParams,
  fetchImplementation: typeof fetch,
): Promise<GoogleTokenResponse> {
  body.set('client_id', credentials.clientId);
  body.set('client_secret', credentials.clientSecret);
  const response = await fetchImplementation(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`google token endpoint returned ${response.status}`);
  }
  return (await response.json()) as GoogleTokenResponse;
}

export async function exchangeGoogleAuthorizationCode(
  environment: Env,
  authorizationCode: string,
  redirectUri: string,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch = fetch,
): Promise<GoogleTokenRecord> {
  const credentials = readGoogleCredentials(environment);
  if (credentials === null) {
    throw new Error('google client credentials missing');
  }
  const payload = await requestGoogleTokens(
    credentials,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
    }),
    fetchImplementation,
  );
  if (!payload.access_token || !payload.refresh_token || !payload.expires_in) {
    // No refresh_token means the consent was granted without access_type=offline
    // or without prompt=consent on a re-authorization. Storing the access token
    // alone would look linked and then fail silently in an hour.
    throw new Error('google token endpoint returned no refresh token');
  }
  const record: GoogleTokenRecord = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMilliseconds: nowMilliseconds + payload.expires_in * 1000,
  };
  await credentials.tokens.put(GOOGLE_TOKEN_KV_KEY, JSON.stringify(record));
  return record;
}

export async function readGoogleTokens(
  environment: Env,
): Promise<GoogleTokenRecord | null> {
  const tokens = environment.GOOGLE_TOKENS;
  if (!tokens) {
    return null;
  }
  return tokens.get<GoogleTokenRecord>(GOOGLE_TOKEN_KV_KEY, 'json');
}

let inFlightGoogleRefresh: Promise<GoogleTokenRecord> | null = null;

export async function refreshGoogleTokens(
  environment: Env,
  currentRecord: GoogleTokenRecord,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch = fetch,
): Promise<GoogleTokenRecord> {
  const credentials = readGoogleCredentials(environment);
  if (credentials === null) {
    throw new Error('google client credentials missing');
  }
  if (inFlightGoogleRefresh === null) {
    inFlightGoogleRefresh = requestGoogleTokens(
      credentials,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRecord.refreshToken,
      }),
      fetchImplementation,
    )
      .then(async (payload) => {
        if (!payload.access_token || !payload.expires_in) {
          throw new Error('google refresh returned an incomplete payload');
        }
        const refreshed: GoogleTokenRecord = {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token ?? currentRecord.refreshToken,
          expiresAtMilliseconds: nowMilliseconds + payload.expires_in * 1000,
        };
        await credentials.tokens.put(GOOGLE_TOKEN_KV_KEY, JSON.stringify(refreshed));
        return refreshed;
      })
      .finally(() => {
        inFlightGoogleRefresh = null;
      });
  }
  return inFlightGoogleRefresh;
}

export const GOOGLE_RECONNECT_MESSAGE =
  'Perdí el acceso a tu calendario de Google. Necesito que lo reconectes.';

async function resolveGoogleAccessToken(
  environment: Env,
  nowMilliseconds: number,
  fetchImplementation: typeof fetch,
): Promise<string | { readonly error: string }> {
  const credentials = readGoogleCredentials(environment);
  if (credentials === null) {
    return { error: 'google client credentials missing' };
  }
  const stored = await readGoogleTokens(environment);
  if (stored === null) {
    return { error: GOOGLE_RECONNECT_MESSAGE };
  }
  if (stored.expiresAtMilliseconds - nowMilliseconds >= REFRESH_MARGIN_MILLISECONDS) {
    return stored.accessToken;
  }
  try {
    const refreshed = await refreshGoogleTokens(
      environment,
      stored,
      nowMilliseconds,
      fetchImplementation,
    );
    return refreshed.accessToken;
  } catch {
    return { error: GOOGLE_RECONNECT_MESSAGE };
  }
}

export async function googleFetch(
  environment: Env,
  path: string,
  init: RequestInit & {
    readonly nowMilliseconds?: number;
    readonly fetchImplementation?: typeof fetch;
  } = {},
): Promise<GoogleFetchResult> {
  const {
    nowMilliseconds = Date.now(),
    fetchImplementation = fetch,
    ...requestInit
  } = init;
  try {
    const resolved = await resolveGoogleAccessToken(
      environment,
      nowMilliseconds,
      fetchImplementation,
    );
    if (typeof resolved !== 'string') {
      return { ok: false, error: resolved.error };
    }
    const headers = new Headers(requestInit.headers);
    headers.set('authorization', `Bearer ${resolved}`);
    if (requestInit.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetchImplementation(
      new URL(path, GOOGLE_API_BASE_URL).toString(),
      { ...requestInit, headers },
    );
    return { ok: true, response };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'google unreachable',
    };
  }
}
