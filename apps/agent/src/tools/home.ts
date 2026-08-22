import { z } from 'zod';

import { activateRoomScene, resolveRoomOrFail, setRoomLights } from '@/home/control';
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

// Tolerant on purpose: a null/empty room from the model means "whole house",
// never a thrown ZodError that fails the turn.
const lightStatusArgsSchema = z
  .object({ room: z.string().nullish() })
  .nullish()
  .transform((value) => ({
    room: value?.room?.trim() ? value.room.trim() : undefined,
  }));

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

// --- Mutations (safety:'unsafe' → tap-confirm on the device) ---

const setLightArgsSchema = z.object({
  room: z.string().trim().min(1),
  on: z.boolean(),
  brightness: z.number().int().min(1).max(100).optional(),
});

export const setLightTool: ToolDefinition = {
  name: 'set_light',
  safety: 'unsafe',
  description:
    'Enciende o apaga las luces de UNA habitación, opcionalmente con brillo 1-100. Siempre requiere el nombre de la habitación; no existe "toda la casa".',
  parameters: {
    type: 'object',
    properties: {
      room: { type: 'string', description: 'Nombre de la habitación' },
      on: { type: 'boolean' },
      brightness: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['room', 'on'],
    additionalProperties: false,
  },
  buildConfirmSummary(args) {
    const parsedArgs = setLightArgsSchema.parse(args);
    const action = parsedArgs.on ? 'Encender' : 'Apagar';
    const brightness =
      parsedArgs.on && parsedArgs.brightness !== undefined
        ? ` al ${parsedArgs.brightness}%`
        : '';
    return `${action} luces de ${parsedArgs.room}${brightness}`;
  },
  async handler(args, context) {
    const parsedArgs = setLightArgsSchema.parse(args);
    try {
      const resolved = await resolveRoomOrFail(context.environment, parsedArgs.room);
      if (typeof resolved === 'string') {
        return { ok: false, summary: resolved };
      }
      const result = await setRoomLights(context.environment, resolved.room, parsedArgs);
      if (!result.ok) {
        return {
          ok: false,
          summary: `No pude cambiar las luces de ${resolved.room.name} (${result.error})`,
        };
      }
      return {
        ok: true,
        summary: parsedArgs.on
          ? `Luces de ${resolved.room.name} encendidas.`
          : `Luces de ${resolved.room.name} apagadas.`,
      };
    } catch (error) {
      return failure(error);
    }
  },
};

const setSceneArgsSchema = z.object({
  room: z.string().trim().min(1),
  scene: z.string().trim().min(1),
});

export const setSceneTool: ToolDefinition = {
  name: 'set_scene',
  safety: 'unsafe',
  description:
    'Activa una escena de Hue en UNA habitación (ej: Relax, Bright, Nightlight). Requiere habitación y nombre de escena.',
  parameters: {
    type: 'object',
    properties: {
      room: { type: 'string' },
      scene: { type: 'string' },
    },
    required: ['room', 'scene'],
    additionalProperties: false,
  },
  buildConfirmSummary(args) {
    const parsedArgs = setSceneArgsSchema.parse(args);
    return `Escena ${parsedArgs.scene} en ${parsedArgs.room}`;
  },
  async handler(args, context) {
    const parsedArgs = setSceneArgsSchema.parse(args);
    try {
      const resolved = await resolveRoomOrFail(context.environment, parsedArgs.room);
      if (typeof resolved === 'string') {
        return { ok: false, summary: resolved };
      }
      const result = await activateRoomScene(
        context.environment,
        resolved.room,
        parsedArgs.scene,
      );
      if (!result.ok) {
        return { ok: false, summary: result.error };
      }
      return {
        ok: true,
        summary: `Escena ${parsedArgs.scene} activada en ${resolved.room.name}.`,
      };
    } catch (error) {
      return failure(error);
    }
  },
};
