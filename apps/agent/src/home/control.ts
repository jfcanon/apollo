import { hueFetch } from '@/home/hue';
import { findRoomByName, readHueHomeSnapshot } from '@/home/state';
import type { HueHomeSnapshot, HueRoomState } from '@/home/state';

// Mutations (Step 3). Every function needs a NAMED room — there is deliberately
// no "whole house" path here; a mis-heard global-off at night is the worst
// realistic failure and this module makes it unexpressible.

export type HueMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

async function putClipResource(
  environment: Env,
  path: string,
  body: unknown,
): Promise<HueMutationResult> {
  const result = await hueFetch(environment, `/route/clip/v2/resource/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (!result.response.ok) {
    return { ok: false, error: `hue returned ${result.response.status}` };
  }
  return { ok: true };
}

export async function resolveRoomOrFail(
  environment: Env,
  roomQuery: string,
): Promise<{ readonly snapshot: HueHomeSnapshot; readonly room: HueRoomState } | string> {
  const snapshot = await readHueHomeSnapshot(environment);
  const room = findRoomByName(snapshot, roomQuery);
  if (room === null) {
    return `No encuentro la habitación ${roomQuery}.`;
  }
  return { snapshot, room };
}

export async function setRoomLights(
  environment: Env,
  room: HueRoomState,
  input: { readonly on: boolean; readonly brightness?: number },
): Promise<HueMutationResult> {
  if (room.groupedLightId === null) {
    return { ok: false, error: `${room.name} no tiene grupo de luces` };
  }
  const body = {
    on: { on: input.on },
    ...(input.on && input.brightness !== undefined
      ? { dimming: { brightness: input.brightness } }
      : {}),
  };
  return putClipResource(environment, `grouped_light/${room.groupedLightId}`, body);
}

type SceneResource = {
  readonly id: string;
  readonly metadata?: { readonly name?: string };
  readonly group?: { readonly rid?: string; readonly rtype?: string };
};

// Scene names repeat across rooms ("Bright", "Dimmed"…), so a scene is only
// ever addressed as room + name.
export async function activateRoomScene(
  environment: Env,
  room: HueRoomState,
  sceneQuery: string,
): Promise<HueMutationResult> {
  const listResult = await hueFetch(environment, '/route/clip/v2/resource/scene');
  if (!listResult.ok) {
    return { ok: false, error: listResult.error };
  }
  if (!listResult.response.ok) {
    return { ok: false, error: `hue returned ${listResult.response.status}` };
  }
  const payload = (await listResult.response.json()) as {
    readonly data?: readonly SceneResource[];
  };
  const normalized = sceneQuery.trim().toLowerCase();
  const roomSceneList = (payload.data ?? []).filter(
    (scene) => scene.group?.rid === room.id,
  );
  const scene =
    roomSceneList.find(
      (candidate) => candidate.metadata?.name?.toLowerCase() === normalized,
    ) ??
    roomSceneList.find((candidate) =>
      candidate.metadata?.name?.toLowerCase().includes(normalized),
    );
  if (scene === undefined) {
    const available = roomSceneList
      .map((candidate) => candidate.metadata?.name ?? '?')
      .join(', ');
    return {
      ok: false,
      error: `${room.name} no tiene la escena ${sceneQuery}. Tiene: ${available}`,
    };
  }
  return putClipResource(environment, `scene/${scene.id}`, {
    recall: { action: 'active' },
  });
}
