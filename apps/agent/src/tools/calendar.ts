import { z } from 'zod';

import { listUpcomingCalendarEvents } from '@/google/calendar';
import { isGoogleConfigured } from '@/google/oauth';
import type { ToolDefinition } from '@/tools/types';

const MAXIMUM_SPOKEN_EVENT_COUNT = 3;

const nextEventsArgsSchema = z.object({
  maxResultCount: z.number().int().min(1).max(10).optional(),
  windowDays: z.number().int().min(1).max(30).optional(),
});

export const nextEventsTool: ToolDefinition = {
  name: 'next_events',
  safety: 'safe',
  description:
    'Consulta los próximos eventos del calendario de Google (qué tengo hoy, qué sigue, agenda de esta semana). Solo lectura.',
  parameters: {
    type: 'object',
    properties: {
      maxResultCount: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Cuántos eventos traer (por defecto 5)',
      },
      windowDays: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        description: 'Cuántos días hacia adelante mirar (por defecto 7)',
      },
    },
    additionalProperties: false,
  },
  async handler(args, context) {
    if (!isGoogleConfigured(context.environment)) {
      return {
        ok: false,
        summary: 'Todavía no tengo tu calendario de Google conectado.',
      };
    }

    const parsedArgs = nextEventsArgsSchema.parse(args);

    const result = await listUpcomingCalendarEvents({
      environment: context.environment,
      nowMilliseconds: context.nowMilliseconds,
      ...(parsedArgs.maxResultCount !== undefined
        ? { maxResultCount: parsedArgs.maxResultCount }
        : {}),
      ...(parsedArgs.windowDays !== undefined
        ? { windowDays: parsedArgs.windowDays }
        : {}),
    });

    if (!result.ok) {
      return { ok: false, summary: `No pude leer tu calendario (${result.error})` };
    }

    if (result.eventList.length === 0) {
      return { ok: true, summary: 'No tenés nada agendado.', data: { eventList: [] } };
    }

    // The summary is SPOKEN, so it reads only the first few; the model still
    // receives the full list in data if it needs to answer a follow-up.
    const spokenEventList = result.eventList
      .slice(0, MAXIMUM_SPOKEN_EVENT_COUNT)
      .map((event) => `${event.title}, ${event.spokenWhen}`)
      .join('. ');
    const remainingCount = result.eventList.length - MAXIMUM_SPOKEN_EVENT_COUNT;
    const remainderPhrase = remainingCount > 0 ? ` Y ${remainingCount} más.` : '';

    return {
      ok: true,
      summary: `${spokenEventList}.${remainderPhrase}`,
      data: { eventList: result.eventList },
    };
  },
};
