import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';
import { hueFetch } from '@/home/hue';

// Ops handle: GET /home/hue/<clip-v2 path> -> api.meethue.com/route/clip/v2/<path>.
// Read-only by construction (GET only) and gated by the dashboard shared
// secret, so it can never darken the house. Voice tools call hueFetch directly.
export const HUE_PROXY_PATH_PREFIX = '/home/hue';

export async function handleHueProxyRequest(
  request: Request,
  requestUrl: URL,
  environment: Env,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }
  const isAuthorized = await isDeviceSharedSecretValid(
    readDeviceTokenFromRequestUrl(requestUrl),
    environment.DASHBOARD_SHARED_SECRET,
  );
  if (!isAuthorized) {
    return new Response('unauthorized', { status: 401 });
  }
  const cliPath = requestUrl.pathname.slice(HUE_PROXY_PATH_PREFIX.length) || '/';
  const result = await hueFetch(environment, `/route/clip/v2${cliPath}`);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 502 });
  }
  return new Response(result.response.body, {
    status: result.response.status,
    headers: {
      'content-type': result.response.headers.get('content-type') ?? 'application/json',
    },
  });
}
