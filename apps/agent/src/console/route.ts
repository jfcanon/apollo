import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';
import { buildConsolePageHtml } from '@/console/page';

// The phone console: the same Jarvis, reached from a browser instead of the
// ESP32. It exists because the board's radio cannot do Bluetooth Classic, so it
// can never drive headphones — the phone already can, and it only needs to
// speak the device protocol.
//
// Served from the Worker rather than a separate app: the page must be
// same-origin with the agent WebSocket, and one HTML string beats a second
// build pipeline for a single screen.
export const CONSOLE_PATH = '/console';

export async function handleConsoleRequest(
  requestUrl: URL,
  environment: Env,
): Promise<Response> {
  // Page access is the dashboard secret; the WebSocket itself still needs the
  // device secret, which the page asks for once and keeps in localStorage.
  const isAuthorized = await isDeviceSharedSecretValid(
    readDeviceTokenFromRequestUrl(requestUrl),
    environment.DASHBOARD_SHARED_SECRET,
  );
  if (!isAuthorized) {
    return new Response('unauthorized', { status: 401 });
  }

  return new Response(buildConsolePageHtml(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: the page carries the client logic, and a stale copy on a
      // phone is invisible until someone wonders why a fix did not land.
      'cache-control': 'no-store',
    },
  });
}
