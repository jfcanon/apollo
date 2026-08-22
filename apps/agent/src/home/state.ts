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

// Room names are spoken, not typed: "TV lights", "tv-lights" and "las luces
// del tv" must all reach the room called "Tvlights". Compare on letters and
// digits only, accents folded, and drop the filler words a voice request adds.
const ROOM_FILLER_WORD_LIST = [
  'luces',
  'luz',
  'lights',
  'light',
  'lamp',
  'lampara',
  'habitacion',
  'cuarto',
  'room',
  'the',
  'las',
  'los',
  'la',
  'el',
  'de',
  'del',
];

export function normalizeRoomName(value: string): string {
  const withoutAccents = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const wordList = withoutAccents
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const meaningfulWordList = wordList.filter(
    (word) => !ROOM_FILLER_WORD_LIST.includes(word),
  );
  return (meaningfulWordList.length > 0 ? meaningfulWordList : wordList).join('');
}

export function findRoomByName(
  snapshot: HueHomeSnapshot,
  roomQuery: string,
): HueRoomState | null {
  const normalized = normalizeRoomName(roomQuery);
  if (normalized.length === 0) {
    return null;
  }
  const normalizedRoomList = snapshot.roomList.map((room) => ({
    room,
    normalizedName: normalizeRoomName(room.name),
  }));
  return (
    normalizedRoomList.find((candidate) => candidate.normalizedName === normalized)
      ?.room ??
    normalizedRoomList.find(
      (candidate) =>
        candidate.normalizedName.includes(normalized) ||
        normalized.includes(candidate.normalizedName),
    )?.room ??
    null
  );
}
