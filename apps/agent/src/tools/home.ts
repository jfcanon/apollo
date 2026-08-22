import { z } from 'zod';

import { findRoomByName, readHueHomeSnapshot } from '@/home/state';
import type { HueLightState, HueRoomState } from '@/home/state';
import type { ToolDefinition, ToolExecutionResult } from '@/tools/types';

// Read-only home tools (Step 2). Nothing here changes the physical world.

function describeRoom(room: HueRoomState): string {
  const onCount = room.lightList.filter((light) => light.on).length;
  return `${room.name} (${onCount} de ${room.lightList.length} encendidas)`;
}

function describeLight(light: HueLightState): string {
  if (!light.on) {
    return `${light.name} apagada`;
  }
  return light.brightness === null
    ? `${light.name} encendida`
    : `${light.name} al ${Math.round(light.brightness)}%`;
}

function failure(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : 'error desconocido';
  return { ok: false, summary: `No pude consultar las luces (${message})` };
}

export const listRoomsTool: ToolDefinition = {
  name: 'list_rooms',
  safety: 'safe',
  description:
    'Lista las habitaciones de la casa y cuántas luces tiene encendidas cada una.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, context) {
    try {
      const snapshot = await readHueHomeSnapshot(context.environment);
      if (snapshot.roomList.length === 0) {
        return { ok: true, summary: 'No hay habitaciones configuradas.', data: snapshot };
      }
      return {
        ok: true,
        summary: `Habitaciones: ${snapshot.roomList.map(describeRoom).join(', ')}.`,
        data: snapshot,
      };
    } catch (error) {
      return failure(error);
    }
  },
};

const lightStatusArgsSchema = z.object({
  room: z.string().min(1).optional(),
});

export const lightStatusTool: ToolDefinition = {
  name: 'light_status',
  safety: 'safe',
  description:
    'Dice qué luces están encendidas y a qué brillo. Sin room responde por toda la casa; con room solo esa habitación.',
  parameters: {
    type: 'object',
    properties: {
      room: { type: 'string', description: 'Nombre de la habitación (opcional)' },
    },
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsedArgs = lightStatusArgsSchema.parse(args);
    try {
      const snapshot = await readHueHomeSnapshot(context.environment);
      if (parsedArgs.room !== undefined) {
        const room = findRoomByName(snapshot, parsedArgs.room);
        if (room === null) {
          return { ok: false, summary: `No encuentro la habitación ${parsedArgs.room}.` };
        }
        return {
          ok: true,
          summary: `${room.name}: ${room.lightList.map(describeLight).join(', ')}.`,
          data: room,
        };
      }
      const allLightList = [
        ...snapshot.roomList.flatMap((room) => room.lightList),
        ...snapshot.unassignedLightList,
      ];
      const onList = allLightList.filter((light) => light.on);
      if (onList.length === 0) {
        return { ok: true, summary: 'Todas las luces están apagadas.', data: snapshot };
      }
      return {
        ok: true,
        summary: `Encendidas: ${onList.map(describeLight).join(', ')}.`,
        data: snapshot,
      };
    } catch (error) {
      return failure(error);
    }
  },
};
