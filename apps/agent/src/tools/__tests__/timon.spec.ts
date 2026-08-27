import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { timonCreateTaskTool } from '@/tools/timon';
import type { Env } from '@/configuration/environment';

function withMockedFetch(handler: (requestUrl: string, init?: RequestInit) => Response): {
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return handler(requestUrl, init);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return createFakeApolloEnvironment({
    TIMON_URL: 'https://timon-worker.example.com',
    TIMON_API_KEY: 'test-key-123',
    ...overrides,
  });
}

describe('timonCreateTaskTool', () => {
  it('returns ok with task data when Timon responds 201', async () => {
    const mocked = withMockedFetch(
      () =>
        new Response(
          JSON.stringify({
            task_id: 'abc-123',
            task: {
              title: 'Comprar leche',
              due_date: '2026-08-28T10:00:00-03:00',
              priority: 'high',
            },
            status: 'created',
          }),
          { status: 201 },
        ),
    );

    try {
      const result = await timonCreateTaskTool.handler(
        {
          title: 'Comprar leche',
          remind_at: '2026-08-28T10:00:00-03:00',
          priority: 'high',
        },
        {
          environment: baseEnv(),
          nowMilliseconds: 1,
          deviceId: 'esp32-jarvis-01',
        },
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe(
        'Guardado: Comprar leche para 2026-08-28T10:00:00-03:00',
      );
      expect(result.data).toMatchObject({
        task_id: 'abc-123',
        title: 'Comprar leche',
        priority: 'high',
        due_date: '2026-08-28T10:00:00-03:00',
      });
    } finally {
      mocked.restore();
    }
  });

  it('omits due_date in summary when no remind_at provided', async () => {
    const mocked = withMockedFetch(
      () =>
        new Response(
          JSON.stringify({
            task_id: 'def-456',
            task: { title: 'Tarea simple', due_date: null, priority: 'medium' },
            status: 'created',
          }),
          { status: 201 },
        ),
    );

    try {
      const result = await timonCreateTaskTool.handler(
        { title: 'Tarea simple' },
        { environment: baseEnv(), nowMilliseconds: 1, deviceId: 'esp32-jarvis-01' },
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('Guardado: Tarea simple');
      expect(result.data?.due_date).toBeNull();
    } finally {
      mocked.restore();
    }
  });

  it('fails with "Timon no está configurado" when TIMON_URL is missing', async () => {
    const result = await timonCreateTaskTool.handler(
      { title: 'Test' },
      {
        environment: createFakeApolloEnvironment({ TIMON_API_KEY: 'key' }),
        nowMilliseconds: 1,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Timon no está configurado');
  });

  it('fails with "Timon no está configurado" when TIMON_API_KEY is missing', async () => {
    const result = await timonCreateTaskTool.handler(
      { title: 'Test' },
      {
        environment: createFakeApolloEnvironment({ TIMON_URL: 'https://x' }),
        nowMilliseconds: 1,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Timon no está configurado');
  });

  it('fails gracefully on Timon 401', async () => {
    const mocked = withMockedFetch(() => new Response('unauthorized', { status: 401 }));

    try {
      const result = await timonCreateTaskTool.handler(
        { title: 'Test' },
        { environment: baseEnv(), nowMilliseconds: 1 },
      );

      expect(result.ok).toBe(false);
      expect(result.summary).toContain('Timon respondió 401');
      expect(result.summary).toContain('No pude guardar la tarea');
    } finally {
      mocked.restore();
    }
  });

  it('fails gracefully on Timon 500', async () => {
    const mocked = withMockedFetch(() => new Response('internal error', { status: 500 }));

    try {
      const result = await timonCreateTaskTool.handler(
        { title: 'Test' },
        { environment: baseEnv(), nowMilliseconds: 1 },
      );

      expect(result.ok).toBe(false);
      expect(result.summary).toContain('Timon respondió 500');
    } finally {
      mocked.restore();
    }
  });

  it('fails with timeout message on AbortError', async () => {
    const mocked = withMockedFetch(() => {
      const error = new DOMException('Aborted', 'AbortError');
      throw error;
    });

    try {
      const result = await timonCreateTaskTool.handler(
        { title: 'Test' },
        { environment: baseEnv(), nowMilliseconds: 1 },
      );

      expect(result.ok).toBe(false);
      expect(result.summary).toContain('Timon no respondió a tiempo');
    } finally {
      mocked.restore();
    }
  });

  it('fails with network error message on fetch rejection', async () => {
    const mocked = withMockedFetch(() => {
      throw new TypeError('Network error');
    });

    try {
      const result = await timonCreateTaskTool.handler(
        { title: 'Test' },
        { environment: baseEnv(), nowMilliseconds: 1 },
      );

      expect(result.ok).toBe(false);
      expect(result.summary).toContain('Error conectando con Timon');
      expect(result.summary).toContain('Network error');
    } finally {
      mocked.restore();
    }
  });

  it('forwards priority and category to Timon', async () => {
    let capturedBody: string | null = null;
    const mocked = withMockedFetch((_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          task_id: 'ghi-789',
          task: { title: 'Test', due_date: null, priority: 'low', category: 'shopping' },
          status: 'created',
        }),
        { status: 201 },
      );
    });

    try {
      await timonCreateTaskTool.handler(
        { title: 'Test', priority: 'low', category: 'shopping' },
        { environment: baseEnv(), nowMilliseconds: 1, deviceId: 'esp32-jarvis-01' },
      );

      expect(capturedBody).not.toBeNull();
      const body = JSON.parse(capturedBody!);
      expect(body.priority).toBe('low');
      expect(body.category).toBe('shopping');
      expect(body.device_id).toBe('esp32-jarvis-01');
    } finally {
      mocked.restore();
    }
  });

  it('buildConfirmSummary returns expected format', () => {
    const summary = timonCreateTaskTool.buildConfirmSummary({
      title: 'Test task',
      remind_at: '2026-08-28T10:00:00-03:00',
    });
    expect(summary).toBe(
      'Crear tarea en Timon: "Test task" para 2026-08-28T10:00:00-03:00',
    );
  });

  it('buildConfirmSummary omits when no remind_at', () => {
    const summary = timonCreateTaskTool.buildConfirmSummary({ title: 'Simple task' });
    expect(summary).toBe('Crear tarea en Timon: "Simple task"');
  });
});
