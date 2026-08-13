interface Env {
  DEVICE_SHARED_SECRET: string;
  DASHBOARD_SHARED_SECRET: string;
  BRIDGE_SHARED_SECRET?: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_STT_MODEL: string;
  OPENROUTER_RESEARCH_MODEL: string;
  OPENROUTER_CODING_MODEL: string;
  OPENROUTER_EMBEDDING_MODEL: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_TTS_MODEL: string;
  TAVILY_API_KEY: string;
  RESEND_API_KEY: string;
  APOLLO_OWNER_EMAIL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  VOICE_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_EXTRA_BODY?: string;
  STT_LANGUAGE?: string;
  AURA_SPEAKER?: string;
  MOCK_VOICE?: string;
  CODING_PROXY_ORIGIN?: string;
  CODING_ENGINE?: string;
  FIRMWARE_PUSH_DISABLED?: string;
}

declare namespace Cloudflare {
  interface Env {
    DEVICE_SHARED_SECRET: string;
    DASHBOARD_SHARED_SECRET: string;
    BRIDGE_SHARED_SECRET?: string;
    OPENROUTER_API_KEY: string;
    OPENROUTER_MODEL: string;
    OPENROUTER_STT_MODEL: string;
    OPENROUTER_RESEARCH_MODEL: string;
    OPENROUTER_CODING_MODEL: string;
    OPENROUTER_EMBEDDING_MODEL: string;
    ELEVENLABS_API_KEY: string;
    ELEVENLABS_TTS_MODEL: string;
    TAVILY_API_KEY: string;
    RESEND_API_KEY: string;
    APOLLO_OWNER_EMAIL: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    VOICE_PROVIDER?: string;
    LLM_BASE_URL?: string;
    LLM_API_KEY?: string;
    LLM_MODEL?: string;
    LLM_EXTRA_BODY?: string;
    STT_LANGUAGE?: string;
    AURA_SPEAKER?: string;
    MOCK_VOICE?: string;
    CODING_PROXY_ORIGIN?: string;
    CODING_ENGINE?: string;
    FIRMWARE_PUSH_DISABLED?: string;
  }
}
