import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';
import { listUpcomingCalendarEvents } from '@/google/calendar';
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CALENDAR_SCOPE,
  buildGoogleRedirectUri,
  exchangeGoogleAuthorizationCode,
  readGoogleTokens,
} from '@/google/oauth';

// One-shot Google OAuth bootstrap, shaped exactly like src/home/oauth.ts: every
// route 404s unless GOOGLE_OAUTH_ENABLED=1, so the surface does not exist
// outside the linking window. /start and /status are additionally gated by the
// dashboard shared secret; /callback cannot carry it (Google redirects there)
// and relies on the single-use state nonce instead.
export const GOOGLE_OAUTH_PATH_PREFIX = '/oauth/google';
const STATE_KV_PREFIX = 'oauth-state:';
const STATE_TTL_SECONDS = 300;

function isOauthEnabled(environment: Env): boolean {
  return environment.GOOGLE_OAUTH_ENABLED === '1';
}

async function isOwnerRequest(requestUrl: URL, environment: Env): Promise<boolean> {
  return isDeviceSharedSecretValid(
    readDeviceTokenFromRequestUrl(requestUrl),
    environment.DASHBOARD_SHARED_SECRET,
  );
}

async function handleStart(requestUrl: URL, environment: Env): Promise<Response> {
  if (!environment.GOOGLE_CLIENT_ID || !environment.GOOGLE_TOKENS) {
    return Response.json(
      { ok: false, error: 'google client credentials missing' },
      { status: 503 },
    );
  }
  const state = crypto.randomUUID();
  await environment.GOOGLE_TOKENS.put(`${STATE_KV_PREFIX}${state}`, '1', {
    expirationTtl: STATE_TTL_SECONDS,
  });
  const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', environment.GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', buildGoogleRedirectUri(requestUrl));
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
  authorizeUrl.searchParams.set('state', state);
  // Without both of these Google returns no refresh_token on a re-authorization,
  // and the link silently becomes a one-hour link.
  authorizeUrl.searchParams.set('access_type', 'offline');
  authorizeUrl.searchParams.set('prompt', 'consent');
  return Response.redirect(authorizeUrl.toString(), 302);
}

async function handleCallback(requestUrl: URL, environment: Env): Promise<Response> {
  const authorizationCode = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  if (!authorizationCode || !state || !environment.GOOGLE_TOKENS) {
    return new Response('missing code or state', { status: 400 });
  }
  const stateKey = `${STATE_KV_PREFIX}${state}`;
  const knownState = await environment.GOOGLE_TOKENS.get(stateKey);
  if (knownState === null) {
    return new Response('unknown or expired state', { status: 400 });
  }
  await environment.GOOGLE_TOKENS.delete(stateKey);
  try {
    await exchangeGoogleAuthorizationCode(
      environment,
      authorizationCode,
      buildGoogleRedirectUri(requestUrl),
      Date.now(),
    );
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'token exchange failed',
      { status: 502 },
    );
  }
  return new Response('google calendar linked. now call /oauth/google/status?token=…', {
    headers: { 'content-type': 'text/plain' },
  });
}

async function handleStatus(environment: Env): Promise<Response> {
  const tokens = await readGoogleTokens(environment);
  if (tokens === null) {
    return Response.json({ ok: true, linked: false });
  }
  const nowMilliseconds = Date.now();
  const events = await listUpcomingCalendarEvents({ environment, nowMilliseconds });
  if (!events.ok) {
    return Response.json({ ok: false, linked: true, error: events.error });
  }
  return Response.json({
    ok: true,
    linked: true,
    expiresAt: new Date(tokens.expiresAtMilliseconds).toISOString(),
    upcomingEventCount: events.eventList.length,
  });
}

export async function handleGoogleOauthRequest(
  requestUrl: URL,
  environment: Env,
): Promise<Response> {
  if (!isOauthEnabled(environment)) {
    return new Response('not found', { status: 404 });
  }
  const action = requestUrl.pathname.slice(GOOGLE_OAUTH_PATH_PREFIX.length);
  if (action === '/callback') {
    return handleCallback(requestUrl, environment);
  }
  if (!(await isOwnerRequest(requestUrl, environment))) {
    return new Response('unauthorized', { status: 401 });
  }
  if (action === '/start') {
    return handleStart(requestUrl, environment);
  }
  if (action === '/status') {
    return handleStatus(environment);
  }
  return new Response('not found', { status: 404 });
}
