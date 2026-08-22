import { hueFetch } from '@/home/hue';

// Read-only snapshot of the house: rooms with their lights. Built from two
// CLIP v2 lists (room, light) joined on the owning device id.

export type HueLightState = {
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  readonly brightness: number | null;
  readonly roomName: string | null;
};

export type HueRoomState = {
  readonly id: string;
  readonly name: string;
  readonly groupedLightId: string | null;
  readonly lightList: readonly HueLightState[];
};

export type HueHomeSnapshot = {
  readonly roomList: readonly HueRoomState[];
  readonly unassignedLightList: readonly HueLightState[];
};

type ClipResource = {
  readonly id: string;
  readonly metadata?: { readonly name?: string };
  readonly on?: { readonly on?: boolean };
  readonly dimming?: { readonly brightness?: number };
  readonly owner?: { readonly rid?: string };
  readonly children?: readonly { readonly rid: string; readonly rtype: string }[];
  readonly services?: readonly { readonly rid: string; readonly rtype: string }[];
};

async function listClipResource(
  environment: Env,
  resourceType: string,
): Promise<readonly ClipResource[]> {
  const result = await hueFetch(environment, `/route/clip/v2/resource/${resourceType}`);
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (!result.response.ok) {
    throw new Error(`hue ${resourceType} returned ${result.response.status}`);
  }
  const payload = (await result.response.json()) as {
    readonly data?: readonly ClipResource[];
  };
  return payload.data ?? [];
}

export async function readHueHomeSnapshot(environment: Env): Promise<HueHomeSnapshot> {
  const [roomResourceList, lightResourceList] = await Promise.all([
    listClipResource(environment, 'room'),
    listClipResource(environment, 'light'),
  ]);

  const roomNameByDeviceId = new Map<string, string>();
  for (const room of roomResourceList) {
    for (const child of room.children ?? []) {
      if (child.rtype === 'device') {
        roomNameByDeviceId.set(child.rid, room.metadata?.name ?? room.id);
      }
    }
  }

  const lightList: readonly HueLightState[] = lightResourceList.map((light) => ({
    id: light.id,
    name: light.metadata?.name ?? light.id,
    on: light.on?.on === true,
    brightness: light.dimming?.brightness ?? null,
    roomName: roomNameByDeviceId.get(light.owner?.rid ?? '') ?? null,
  }));

  const roomList: readonly HueRoomState[] = roomResourceList.map((room) => {
    const roomName = room.metadata?.name ?? room.id;
    return {
      id: room.id,
      name: roomName,
      groupedLightId:
        room.services?.find((service) => service.rtype === 'grouped_light')?.rid ?? null,
      lightList: lightList.filter((light) => light.roomName === roomName),
    };
  });

  return {
    roomList,
    unassignedLightList: lightList.filter((light) => light.roomName === null),
  };
}

export function findRoomByName(
  snapshot: HueHomeSnapshot,
  roomQuery: string,
): HueRoomState | null {
  const normalized = roomQuery.trim().toLowerCase();
  return (
    snapshot.roomList.find((room) => room.name.toLowerCase() === normalized) ??
    snapshot.roomList.find((room) => room.name.toLowerCase().includes(normalized)) ??
    null
  );
}
