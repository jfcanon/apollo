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
    const parsedResult = lightStatusArgsSchema.safeParse(args);
    const parsedArgs = parsedResult.success ? parsedResult.data : { room: undefined };
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

// The model is the caller here, and it sends "true"/"on"/"1" as often as a
// real boolean. Coerce instead of throwing: a ZodError escaping a handler kills
// the whole turn (the device just shows "Error"), so every argument problem has
// to come back as an ordinary spoken tool failure.
const onValueSchema = z.union([
  z.boolean(),
  z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .refine((value) =>
      ['true', 'false', 'on', 'off', '1', '0', 'encender', 'apagar', 'prender'].includes(
        value,
      ),
    )
    .transform((value) => ['true', 'on', '1', 'encender', 'prender'].includes(value)),
  z.number().transform((value) => value !== 0),
]);

const brightnessValueSchema = z.coerce.number().int().min(1).max(100);

const setLightArgsSchema = z.object({
  room: z.string().trim().min(1),
  on: onValueSchema,
  brightness: brightnessValueSchema.optional(),
});

function describeInvalidArguments(toolName: string): ToolExecutionResult {
  return {
    ok: false,
    summary:
      toolName === 'set_scene'
        ? 'Necesito la habitación y el nombre de la escena.'
        : 'Necesito saber qué habitación y si la prendo o la apago.',
  };
}

export const setLightTool: ToolDefinition = {
  name: 'set_light',
  safety: 'unsafe',
  description:
    'Enciende o apaga las luces de UNA habitación (turn the lights on/off in one room), opcionalmente con brillo 1-100. room acepta el nombre tal como lo dice el usuario, en español o inglés. Siempre requiere habitación: no existe "toda la casa" ni "all off".',
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
    const action = parsedArgs.on ? 'Enciendo' : 'Apago';
    const brightness =
      parsedArgs.on && parsedArgs.brightness !== undefined
        ? ` al ${parsedArgs.brightness}%`
        : '';
    return `¿${action} las luces de ${parsedArgs.room}${brightness}?`;
  },
  async handler(args, context) {
    const parsedResult = setLightArgsSchema.safeParse(args);
    if (!parsedResult.success) {
      return describeInvalidArguments('set_light');
    }
    const parsedArgs = parsedResult.data;
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
    return `¿Activo la escena ${parsedArgs.scene} en ${parsedArgs.room}?`;
  },
  async handler(args, context) {
    const parsedResult = setSceneArgsSchema.safeParse(args);
    if (!parsedResult.success) {
      return describeInvalidArguments('set_scene');
    }
    const parsedArgs = parsedResult.data;
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
