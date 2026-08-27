import { z } from 'zod';

import type { ToolDefinition } from '@/tools/types';

const TIMON_TIMEOUT_MS = 5_000;

const timonCreateTaskArgsSchema = z.object({
  title: z.string().min(1).max(500),
  remind_at: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  category: z.string().optional(),
});

export const timonCreateTaskTool: ToolDefinition = {
  name: 'timon_create_task',
  safety: 'safe',
  description:
    'Crea una tarea en Timon (gestor de tareas). Usa esto cuando el usuario quiera registrar una tarea, recordatorio pendiente, o algo que hacer.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título o descripción de la tarea' },
      remind_at: {
        type: 'string',
        description: 'Fecha/hora ISO 8601 para recordatorio (opcional)',
      },
      priority: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Prioridad de la tarea (opcional)',
      },
      category: {
        type: 'string',
        description: 'Categoría de la tarea (opcional)',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsed = timonCreateTaskArgsSchema.parse(args);

    const timonUrl = context.environment.TIMON_URL;
    const timonApiKey = context.environment.TIMON_API_KEY;

    if (!timonUrl || !timonApiKey) {
      return {
        ok: false,
        summary:
          'Timon no está configurado. Pedile al owner que configure TIMON_URL y TIMON_API_KEY.',
      };
    }

    const text = parsed.remind_at
      ? `${parsed.title} para ${parsed.remind_at}`
      : parsed.title;

    const body: Record<string, unknown> = { text };
    if (context.deviceId) body.device_id = context.deviceId;
    if (parsed.remind_at) body.ts = parsed.remind_at;
    if (parsed.priority) body.priority = parsed.priority;
    if (parsed.category) body.category = parsed.category;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMON_TIMEOUT_MS);

    try {
      const response = await fetch(`${timonUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${timonApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        return {
          ok: false,
          summary: `Timon respondió ${response.status}: ${errorBody}. No pude guardar la tarea, intentá repetir.`,
        };
      }

      const data = (await response.json()) as {
        task_id: string;
        task: { title: string; due_date: string | null; priority: string };
        status: string;
      };

      const when = data.task.due_date ? ` para ${data.task.due_date}` : '';

      return {
        ok: true,
        summary: `Guardado: ${data.task.title}${when}`,
        data: {
          task_id: data.task_id,
          title: data.task.title,
          priority: data.task.priority,
          due_date: data.task.due_date,
        },
      };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          ok: false,
          summary: 'Timon no respondió a tiempo. Intentá repetir.',
        };
      }
      return {
        ok: false,
        summary: `Error conectando con Timon: ${err instanceof Error ? err.message : 'unknown'}. Intentá repetir.`,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
  buildConfirmSummary(args) {
    const parsed = timonCreateTaskArgsSchema.parse(args);
    const when = parsed.remind_at ? ` para ${parsed.remind_at}` : '';
    return `Crear tarea en Timon: "${parsed.title}"${when}`;
  },
};
