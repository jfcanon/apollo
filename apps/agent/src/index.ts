import { routeAgentRequest } from 'agents';
import { Sandbox } from '@cloudflare/sandbox';

import { authorizeApolloConnection, Apollo } from '@/agents/apollo';
import { handleBrainProxyRequest } from '@/brain/proxy';
import { GOOGLE_OAUTH_PATH_PREFIX, handleGoogleOauthRequest } from '@/google/routes';
import { HUE_OAUTH_PATH_PREFIX, handleHueOauthRequest } from '@/home/oauth';
import { HUE_PROXY_PATH_PREFIX, handleHueProxyRequest } from '@/home/proxy';
import { CODING_PROXY_PATH_PREFIX, handleCodingLlmProxyRequest } from '@/coding/proxy';
import { handleOtaRequest } from '@/ota/routes';
import { consumeApolloQueueBatch } from '@/queues/consume';
import { ApolloBackground } from '@/workflows/background';
import { ApolloCoding } from '@/workflows/coding';

export { Apollo, ApolloBackground, ApolloCoding, Sandbox };

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/health') {
      return Response.json({
        ok: true,
        name: 'apollo',
        features: ['session', 'vectorize', 'r2', 'queues', 'workflows'],
      });
    }

    if (requestUrl.pathname.startsWith('/ota/')) {
      return handleOtaRequest(request, requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith(`${GOOGLE_OAUTH_PATH_PREFIX}/`)) {
      return handleGoogleOauthRequest(requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith(`${HUE_OAUTH_PATH_PREFIX}/`)) {
      return handleHueOauthRequest(requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith(`${HUE_PROXY_PATH_PREFIX}/`)) {
      return handleHueProxyRequest(request, requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith('/brain/')) {
      return handleBrainProxyRequest(request, requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith(`${CODING_PROXY_PATH_PREFIX}/`)) {
      return handleCodingLlmProxyRequest(request, requestUrl, environment);
    }

    const agentResponse = await routeAgentRequest(request, environment, {
      onBeforeConnect: async (connectRequest) =>
        authorizeApolloConnection(connectRequest, environment),
    });

    if (agentResponse !== undefined && agentResponse !== null) {
      return agentResponse;
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, environment: Env): Promise<void> {
    await consumeApolloQueueBatch(batch, environment);
  },
} satisfies ExportedHandler<Env>;
