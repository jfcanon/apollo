import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';
import {
  HUE_AUTHORIZE_URL,
  bootstrapHueApplicationKey,
  exchangeHueAuthorizationCode,
  hueFetch,
  readHueTokens,
} from '@/home/hue';

// One-shot Hue OAuth bootstrap. Every route 404s unless HUE_OAUTH_ENABLED=1 so
// the surface does not exist outside the linking window; flip it back off once
// /oauth/hue/status reports linked. /start and /bootstrap are additionally
// gated by the dashboard shared secret; /callback cannot carry it (Hue
// redirects there) and relies on the single-use state nonce instead.
export const HUE_OAUTH_PATH_PREFIX = '/oauth/hue';
const STATE_KV_PREFIX = 'oauth-state:';
const STATE_TTL_SECONDS = 300;

function isOauthEnabled(environment: Env): boolean {
  return environment.HUE_OAUTH_ENABLED === '1';
}

async function isOwnerRequest(requestUrl: URL, environment: Env): Promise<boolean> {
  return isDeviceSharedSecretValid(
    readDeviceTokenFromRequestUrl(requestUrl),
    environment.DASHBOARD_SHARED_SECRET,
  );
}

async function handleStart(environment: Env): Promise<Response> {
  if (!environment.HUE_CLIENT_ID || !environment.HUE_TOKENS) {
    return Response.json(
      { ok: false, error: 'hue client credentials missing' },
      { status: 503 },
    );
  }
  const state = crypto.randomUUID();
  await environment.HUE_TOKENS.put(`${STATE_KV_PREFIX}${state}`, '1', {
    expirationTtl: STATE_TTL_SECONDS,
  });
  const authorizeUrl = new URL(HUE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', environment.HUE_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  return Response.redirect(authorizeUrl.toString(), 302);
}

async function handleCallback(requestUrl: URL, environment: Env): Promise<Response> {
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  if (!code || !state || !environment.HUE_TOKENS) {
    return new Response('missing code or state', { status: 400 });
  }
  const stateKey = `${STATE_KV_PREFIX}${state}`;
  const known = await environment.HUE_TOKENS.get(stateKey);
  if (known === null) {
    return new Response('unknown or expired state', { status: 400 });
  }
  await environment.HUE_TOKENS.delete(stateKey);
  try {
    await exchangeHueAuthorizationCode(environment, code, Date.now());
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'token exchange failed',
      {
        status: 502,
      },
    );
  }
  return new Response('hue linked. now call /oauth/hue/bootstrap?token=…', {
    headers: { 'content-type': 'text/plain' },
  });
}

async function handleBootstrap(environment: Env): Promise<Response> {
  const result = await bootstrapHueApplicationKey(environment);
  return Response.json(result, { status: result.ok ? 200 : 502 });
}

async function handleStatus(environment: Env): Promise<Response> {
  const tokens = await readHueTokens(environment);
  if (tokens === null) {
    return Response.json({ ok: true, linked: false });
  }
  const lights = await hueFetch(environment, '/route/clip/v2/resource/light');
  if (!lights.ok) {
    return Response.json({ ok: false, linked: true, error: lights.error });
  }
  const payload = (await lights.response.json()) as {
    readonly data?: readonly unknown[];
  };
  return Response.json({
    ok: lights.response.ok,
    linked: true,
    expiresAt: new Date(tokens.expiresAtMilliseconds).toISOString(),
    upstreamStatus: lights.response.status,
    lightCount: payload.data?.length ?? 0,
  });
}

export async function handleHueOauthRequest(
  requestUrl: URL,
  environment: Env,
): Promise<Response> {
  if (!isOauthEnabled(environment)) {
    return new Response('not found', { status: 404 });
  }
  const action = requestUrl.pathname.slice(HUE_OAUTH_PATH_PREFIX.length);
  if (action === '/callback') {
    return handleCallback(requestUrl, environment);
  }
  if (!(await isOwnerRequest(requestUrl, environment))) {
    return new Response('unauthorized', { status: 401 });
  }
  if (action === '/start') {
    return handleStart(environment);
  }
  if (action === '/bootstrap') {
    return handleBootstrap(environment);
  }
  if (action === '/status') {
    return handleStatus(environment);
  }
  return new Response('not found', { status: 404 });
}
