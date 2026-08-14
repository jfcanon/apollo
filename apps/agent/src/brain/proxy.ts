import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';

// Brain Jarvis client: calls the isolated Lima VM over its Cloudflare Tunnel,
// authenticated with the Access service token. The VM has no LAN and no inbound
// ports — this outbound-only hostname is the only way in, and Access denies
// anything without the token pair. Never the Mac.
export async function callBrain(
  environment: Env,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const baseUrl = environment.BRAIN_URL ?? 'https://brain.ygdcbtmc4u.uk';
  const headers = new Headers(init?.headers);
  // A missing token means Access returns 403 at the edge — fail closed, never
  // send an unauthenticated brain request.
  headers.set('CF-Access-Client-Id', environment.BRAIN_ACCESS_CLIENT_ID ?? '');
  headers.set('CF-Access-Client-Secret', environment.BRAIN_ACCESS_CLIENT_SECRET ?? '');
  return fetch(new URL(path, baseUrl).toString(), { ...init, headers });
}

// External proxy route: /brain/<path> -> brain <path>. Gated by the dashboard
// shared secret (a management surface), so it is not itself an open door to the
// brain. Primarily a verification/ops handle; the voice turn uses callBrain
// directly.
export async function handleBrainProxyRequest(
  request: Request,
  requestUrl: URL,
  environment: Env,
): Promise<Response> {
  const presentedToken = readDeviceTokenFromRequestUrl(requestUrl);
  const isAuthorized = await isDeviceSharedSecretValid(
    presentedToken,
    environment.DASHBOARD_SHARED_SECRET,
  );
  if (!isAuthorized) {
    return new Response('unauthorized', { status: 401 });
  }

  const brainPath = requestUrl.pathname.slice('/brain'.length) || '/';
  try {
    const brainResponse = await callBrain(environment, brainPath, {
      method: request.method,
      ...(request.method !== 'GET' && request.method !== 'HEAD'
        ? { body: await request.arrayBuffer() }
        : {}),
    });
    // Surface the brain status so a caller can tell 403 (Access) from 502
    // (tunnel up, backend down) from 200.
    return new Response(brainResponse.body, {
      status: brainResponse.status,
      headers: {
        'content-type': brainResponse.headers.get('content-type') ?? 'text/plain',
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'brain unreachable' },
      { status: 502 },
    );
  }
}
