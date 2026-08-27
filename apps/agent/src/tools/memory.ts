import { z } from 'zod';

import type { ToolDefinition } from '@/tools/types';

const rememberFactArgsSchema = z.object({
  content: z.string().min(1).max(2000),
});

export const rememberFactTool: ToolDefinition = {
  name: 'remember_fact',
  safety: 'safe',
  description: 'Guarda un dato en la memoria del escritorio',
  parameters: {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
    additionalProperties: false,
  },
  async handler(args, context) {
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }

    const parsedArgs = rememberFactArgsSchema.parse(args);
    const persistedMemory = await context.effects.persistMemory(parsedArgs.content);

    return {
      ok: true,
      summary: `Recordado: ${persistedMemory.content}`,
      data: persistedMemory,
    };
  },
};

const recallMemoryArgsSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5),
});

export const recallMemoryTool: ToolDefinition = {
  name: 'recall_memory',
  safety: 'safe',
  description: 'Busca en la memoria semántica del escritorio',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsedArgs = recallMemoryArgsSchema.parse(args);
    const deviceId = context.deviceId ?? 'default';

    try {
      const { embedTextWithLlm, queryMemoryVectors } = await import('@/memory/vector');
      const values = await embedTextWithLlm({
        apiKey: context.environment.LLM_API_KEY ?? '',
        baseUrl: context.environment.LLM_BASE_URL ?? 'https://api.deepseek.com',
        modelId: context.environment.LLM_MODEL ?? 'deepseek-chat',
        text: parsedArgs.query,
      });
      const matchList = await queryMemoryVectors({
        vectorizeIndex: context.environment.VECTORIZE,
        values,
        deviceId,
        topK: parsedArgs.limit,
      });
      const usableMatchList = matchList.filter((match) => match.content.length > 0);
      if (usableMatchList.length === 0) {
        return {
          ok: true,
          summary: `No encontré nada sobre ${parsedArgs.query}`,
          data: { matchList: [] },
        };
      }
      return {
        ok: true,
        summary: `Recordé ${usableMatchList.length} cosas: ${usableMatchList
          .map((match) => match.content)
          .join('; ')}`,
        data: {
          matchList: usableMatchList.map((match) => ({
            id: match.id,
            content: match.content,
            score: match.score,
          })),
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary:
          error instanceof Error
            ? `No pude recordar: ${error.message}`
            : 'No pude recordar',
      };
    }
  },
};
