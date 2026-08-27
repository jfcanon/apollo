import { z } from 'zod';

const openRouterEmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

export type MemoryVectorMatch = {
  readonly id: string;
  readonly content: string;
  readonly score: number;
};

export async function embedTextWithLlm(input: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly text: string;
}): Promise<number[]> {
  const response = await fetch(`${input.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelId,
      input: input.text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding falló con status ${response.status}`);
  }

  const payload = openRouterEmbeddingResponseSchema.parse(await response.json());
  return payload.data[0].embedding;
}

export async function upsertMemoryVector(input: {
  readonly vectorizeIndex: VectorizeIndex;
  readonly memoryId: string;
  readonly content: string;
  readonly values: number[];
  readonly deviceId: string;
}): Promise<void> {
  await input.vectorizeIndex.upsert([
    {
      id: input.memoryId,
      values: input.values,
      namespace: input.deviceId,
      metadata: {
        content: input.content.slice(0, 2048),
      },
    },
  ]);
}

export async function queryMemoryVectors(input: {
  readonly vectorizeIndex: VectorizeIndex;
  readonly values: number[];
  readonly deviceId: string;
  readonly topK?: number;
}): Promise<readonly MemoryVectorMatch[]> {
  const queryResult = await input.vectorizeIndex.query(input.values, {
    topK: input.topK ?? 5,
    namespace: input.deviceId,
    returnMetadata: 'all',
  });

  return queryResult.matches.map((match) => ({
    id: match.id,
    content: typeof match.metadata?.content === 'string' ? match.metadata.content : '',
    score: match.score,
  }));
}

export async function recallSemanticMemoryContent(input: {
  readonly vectorizeIndex: VectorizeIndex | undefined;
  readonly embeddingBaseUrl: string;
  readonly embeddingApiKey: string;
  readonly embeddingModelId: string;
  readonly queryText: string;
  readonly deviceId: string;
  readonly topK?: number;
}): Promise<readonly string[]> {
  if (input.vectorizeIndex === undefined || input.queryText.trim().length === 0) {
    return [];
  }

  try {
    const values = await embedTextWithLlm({
      apiKey: input.embeddingApiKey,
      baseUrl: input.embeddingBaseUrl,
      modelId: input.embeddingModelId,
      text: input.queryText,
    });
    const matchList = await queryMemoryVectors({
      vectorizeIndex: input.vectorizeIndex,
      values,
      deviceId: input.deviceId,
      topK: input.topK,
    });
    return matchList
      .filter((match) => match.content.length > 0)
      .map((match) => match.content);
  } catch {
    return [];
  }
}
