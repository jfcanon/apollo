import { z } from 'zod';

import type { ToolDefinition, ToolExecutionResult } from '@/tools/types';

// The Hue Play HDMI Sync Box is invisible to the Hue cloud — it is not a bridge
// device, and /resource/entertainment only lists the lamps. Its LAN API is the
// only way in, so these tools route through the desk device, which is already
// on the LAN and holds the pairing token in its own NVS. The Worker never sees
// that token and never talks to the Sync Box directly.

export const SYNC_BOX_STATUS_TOOL_NAME = 'self.syncbox.get_status';
export const SYNC_BOX_SET_SYNC_TOOL_NAME = 'self.syncbox.set_sync';
export const SYNC_BOX_SET_MODE_TOOL_NAME = 'self.syncbox.set_mode';
export const SYNC_BOX_SET_SOURCE_TOOL_NAME = 'self.syncbox.set_source';
export const SYNC_BOX_PAIR_TOOL_NAME = 'self.syncbox.pair';
export const SYNC_BOX_SET_ADDRESS_TOOL_NAME = 'self.syncbox.set_address';

const SYNC_BOX_MODE_LIST = ['video', 'music', 'game', 'passthrough'] as const;
const SYNC_BOX_SOURCE_LIST = ['input1', 'input2', 'input3', 'input4'] as const;

const setSyncArgsSchema = z.object({
  on: z.union([
    z.boolean(),
    z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .transform((value) => ['true', 'on', '1', 'encender', 'prender'].includes(value)),
  ]),
});

const setModeArgsSchema = z.object({
  mode: z.enum(SYNC_BOX_MODE_LIST),
});

const setSourceArgsSchema = z.object({
  source: z.enum(SYNC_BOX_SOURCE_LIST),
});

const setAddressArgsSchema = z.object({
  address: z.string().trim().min(7),
});

async function callDevice(
  context: Parameters<ToolDefinition['handler']>[1],
  deviceToolName: string,
  argumentRecord: Record<string, unknown>,
  successSummary: string,
): Promise<ToolExecutionResult> {
  if (!context.effects) {
    return { ok: false, summary: 'Effects no disponibles' };
  }
  const deviceResult = await context.effects.callDeviceTool({
    deviceToolName,
    argumentRecord,
  });
  if (!deviceResult.ok) {
    return {
      ok: false,
      summary: `No pude hablar con el Sync Box (${deviceResult.summary})`,
    };
  }
  return { ok: true, summary: successSummary, data: deviceResult.data };
}

export const syncBoxStatusTool: ToolDefinition = {
  name: 'sync_box_status',
  safety: 'safe',
  description:
    'Dice si el Hue Sync Box está sincronizando, en qué modo y en qué entrada HDMI.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, context) {
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }
    const deviceResult = await context.effects.callDeviceTool({
      deviceToolName: SYNC_BOX_STATUS_TOOL_NAME,
      argumentRecord: {},
    });
    if (!deviceResult.ok) {
      return { ok: false, summary: `No pude leer el Sync Box (${deviceResult.summary})` };
    }
    return {
      ok: true,
      summary: `Sync Box: ${deviceResult.summary}`,
      data: deviceResult.data,
    };
  },
};

export const syncBoxSetSyncTool: ToolDefinition = {
  name: 'sync_box_set_sync',
  safety: 'unsafe',
  description:
    'Enciende o apaga la sincronización de luces del Hue Sync Box (turn the TV light sync on/off).',
  parameters: {
    type: 'object',
    properties: { on: { type: 'boolean' } },
    required: ['on'],
    additionalProperties: false,
  },
  buildConfirmSummary(args) {
    const parsedArgs = setSyncArgsSchema.parse(args);
    return parsedArgs.on
      ? '¿Prendo el sync del Sync Box?'
      : '¿Apago el sync del Sync Box?';
  },
  async handler(args, context) {
    const parsedResult = setSyncArgsSchema.safeParse(args);
    if (!parsedResult.success) {
      return { ok: false, summary: 'Necesito saber si prendo o apago el sync.' };
    }
    return callDevice(
      context,
      SYNC_BOX_SET_SYNC_TOOL_NAME,
      { on: parsedResult.data.on },
      parsedResult.data.on ? 'Sync encendido.' : 'Sync apagado.',
    );
  },
};

export const syncBoxSetModeTool: ToolDefinition = {
  name: 'sync_box_set_mode',
  safety: 'unsafe',
  description:
    'Cambia el modo del Hue Sync Box: video, music, game o passthrough (passthrough = pasa la imagen sin sincronizar luces).',
  parameters: {
    type: 'object',
    properties: { mode: { type: 'string', enum: [...SYNC_BOX_MODE_LIST] } },
    required: ['mode'],
    additionalProperties: false,
  },
  buildConfirmSummary(args) {
    const parsedArgs = setModeArgsSchema.parse(args);
    return `¿Pongo el Sync Box en modo ${parsedArgs.mode}?`;
  },
  async handler(args, context) {
    const parsedResult = setModeArgsSchema.safeParse(args);
    if (!parsedResult.success) {
      return {
        ok: false,
        summary: 'El modo tiene que ser video, music, game o passthrough.',
      };
    }
    return callDevice(
      context,
      SYNC_BOX_SET_MODE_TOOL_NAME,
      { mode: parsedResult.data.mode },
      `Sync Box en modo ${parsedResult.data.mode}.`,
    );
  },
};

export const syncBoxSetSourceTool: ToolDefinition = {
  name: 'sync_box_set_source',
  safety: 'unsafe',
  description:
    'Cambia la entrada HDMI del Hue Sync Box (input1 a input4). Usalo para pasar al Apple TV, la consola, etc.',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string', enum: [...SYNC_BOX_SOURCE_LIST] } },
    required: ['source'],
    additionalProperties: false,
  },
  buildConfirmSummary(args) {
    const parsedArgs = setSourceArgsSchema.parse(args);
    return `¿Cambio el Sync Box a ${parsedArgs.source}?`;
  },
  async handler(args, context) {
    const parsedResult = setSourceArgsSchema.safeParse(args);
    if (!parsedResult.success) {
      return {
        ok: false,
        summary: 'La entrada tiene que ser input1, input2, input3 o input4.',
      };
    }
    return callDevice(
      context,
      SYNC_BOX_SET_SOURCE_TOOL_NAME,
      { source: parsedResult.data.source },
      `Sync Box en ${parsedResult.data.source}.`,
    );
  },
};

// Setup, spoken once: the address first, then pairing while the owner holds the
// Sync Box button. Both are 'unsafe' so neither happens without a tap.
export const syncBoxSetAddressTool: ToolDefinition = {
  name: 'sync_box_set_address',
  safety: 'unsafe',
  description: 'Guarda la IP del Hue Sync Box en el dispositivo (una sola vez).',
  parameters: {
    type: 'object',
    properties: { address: { type: 'string' } },
    required: ['address'],
    additionalProperties: false,
  },
  buildConfirmSummary(args) {
    const parsedArgs = setAddressArgsSchema.parse(args);
    return `¿Guardo la IP ${parsedArgs.address} del Sync Box?`;
  },
  async handler(args, context) {
    const parsedResult = setAddressArgsSchema.safeParse(args);
    if (!parsedResult.success) {
      return { ok: false, summary: 'Necesito la IP del Sync Box.' };
    }
    return callDevice(
      context,
      SYNC_BOX_SET_ADDRESS_TOOL_NAME,
      { address: parsedResult.data.address },
      `IP del Sync Box guardada: ${parsedResult.data.address}.`,
    );
  },
};

export const syncBoxPairTool: ToolDefinition = {
  name: 'sync_box_pair',
  safety: 'unsafe',
  description:
    'Empareja el dispositivo con el Hue Sync Box. Antes de llamarlo, pedile al usuario que MANTENGA APRETADO el botón del Sync Box 3 segundos.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  buildConfirmSummary() {
    return '¿Emparejo con el Sync Box? Mantené apretado su botón 3 segundos.';
  },
  async handler(_args, context) {
    return callDevice(
      context,
      SYNC_BOX_PAIR_TOOL_NAME,
      {},
      'Emparejado con el Sync Box.',
    );
  },
};
