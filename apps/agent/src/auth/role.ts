import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';

export type ApolloConnectionRole = 'device' | 'dashboard' | 'bridge';

export const DEVICE_CONNECTION_TAG: ApolloConnectionRole = 'device';
export const BRIDGE_CONNECTION_TAG: ApolloConnectionRole = 'bridge';

export function hasDeviceConnectionTag(connectionTagList: readonly string[]): boolean {
  return connectionTagList.includes(DEVICE_CONNECTION_TAG);
}

export function hasBridgeConnectionTag(connectionTagList: readonly string[]): boolean {
  return connectionTagList.includes(BRIDGE_CONNECTION_TAG);
}

export async function resolveApolloConnectionRole(
  requestUrl: URL,
  environment: Env,
): Promise<ApolloConnectionRole | null> {
  const presentedToken = readDeviceTokenFromRequestUrl(requestUrl);
  if (await isDeviceSharedSecretValid(presentedToken, environment.DEVICE_SHARED_SECRET)) {
    return 'device';
  }
  if (
    await isDeviceSharedSecretValid(presentedToken, environment.DASHBOARD_SHARED_SECRET)
  ) {
    return 'dashboard';
  }
  // The Mac bridge daemon presents its own secret: a leaked device token must
  // never grant machine access, and vice versa.
  if (
    await isDeviceSharedSecretValid(
      presentedToken,
      environment.BRIDGE_SHARED_SECRET ?? '',
    )
  ) {
    return 'bridge';
  }
  return null;
}
