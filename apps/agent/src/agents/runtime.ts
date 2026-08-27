import type { Connection } from 'agents';
import type { Session } from 'agents/experimental/memory/session';

import type { ApolloState } from '@/agents/apollo';
import { createInactiveDeskFocusState, tickDeskFocus } from '@/focus/logic';
import { isNamespacedMcpToolName } from '@/mcp/naming';
import {
  buildRecentTurnHistoryMessageList,
  buildSessionSystemPrompt,
} from '@/memory/session';
import type { MemorySqlExecutor } from '@/memory/store';
import { recallSemanticMemoryContent } from '@/memory/vector';
import { resolveDeskSpeechMode } from '@/persona/catalog';
import { resolveDeskFaceEmotion } from '@/persona/face';
import { APOLLO_TTS_VOICE, buildInstalledToolPromptNote } from '@/persona/soul';
import { encodeServerToDeviceMessage } from '@/protocol/schema';
import type { DeskUiMachine } from '@/session/machine';
import { buildTelemetryPromptNote, type DeskTelemetrySnapshot } from '@/telemetry/logic';
import { createBuiltinToolDefinitionMap } from '@/tools/catalog';
import type {
  DeskToolEffects,
  PendingToolConfirmation,
  ToolDefinition,
} from '@/tools/types';
import { runDeskTurn, type VoiceAdapters } from '@/turn/run';
import { TTS_PCM_CHANNEL_COUNT, TTS_PCM_SAMPLE_RATE_HZ } from '@/voice/elevenlabs';
import { chatWithLlm } from '@/voice/llm';
import { synthesizeSpeechWithGemini } from '@/voice/gemini';
import { synthesizeSpeechWithGroq, transcribeAudioWithGroq } from '@/voice/groq';
import {
  synthesizeSpeechWithWorkersAi,
  transcribeAudioWithWorkersAi,
} from '@/voice/workersai';
import { synthesizeSpeechThroughCache } from '@/voice/ttscache';
import {
  streamAudioChunksAtPlaybackPace,
  type PlaybackAckSnapshot,
} from '@/voice/stream';
import { synthesizeApolloSpeech } from '@/voice/synthesize';
import { wrapPcmAsWavBuffer } from '@/voice/wav';

export type ApolloTurnRuntimeDependencies = {
  readonly environment: Env;
  readonly sqlExecutor: MemorySqlExecutor;
  readonly uiMachine: DeskUiMachine;
  readonly currentState: ApolloState;
  readonly getCurrentState: () => ApolloState;
  readonly setAgentState: (nextState: ApolloState) => void;
  readonly scheduleConfirmExpiry: (confirmationId: string) => Promise<void>;
  readonly persistPendingConfirmation: (
    confirmation: PendingToolConfirmation,
  ) => Promise<void>;
  readonly session: Session;
  readonly deviceId: string;
  readonly effects: DeskToolEffects;
  readonly runBridgeCommand?: (commandName: string) => Promise<string>;
  readonly toolDefinitionMap?: ReadonlyMap<string, ToolDefinition>;
  readonly isSpeechAborted?: () => boolean;
  readonly telemetrySnapshot?: DeskTelemetrySnapshot;
  readonly allocateTtsSequence?: () => number;
  readonly getPlaybackAckForSequence?: (sequence: number) => PlaybackAckSnapshot | null;
};

export async function executeApolloTurn(
  connection: Connection,
  dependencies: ApolloTurnRuntimeDependencies,
  turnPart: {
    readonly text?: string;
    readonly audioBuffer?: ArrayBuffer;
    readonly confirmOk?: boolean;
    readonly pendingConfirmation?: PendingToolConfirmation;
  },
): Promise<void> {
  const nowMilliseconds = Date.now();
  const focusState = tickDeskFocus(
    dependencies.currentState.focusEndsAt === null
      ? createInactiveDeskFocusState()
      : {
          active: true,
          endsAt: dependencies.currentState.focusEndsAt,
        },
    nowMilliseconds,
  );

  const isMockVoice = dependencies.environment.MOCK_VOICE === '1';
  const sessionSystemPrompt = await buildSessionSystemPrompt(dependencies.session);
  const recentHistoryMessageList = await buildRecentTurnHistoryMessageList(
    dependencies.session,
  );
  const recallSemanticMemoryContentList = async (
    queryText: string,
  ): Promise<readonly string[]> =>
    recallSemanticMemoryContent({
      vectorizeIndex: dependencies.environment.VECTORIZE,
      embeddingBaseUrl: dependencies.environment.LLM_BASE_URL ?? '',
      embeddingApiKey: dependencies.environment.LLM_API_KEY ?? '',
      embeddingModelId: dependencies.environment.LLM_MODEL ?? '',
      queryText,
      deviceId: dependencies.deviceId,
    });

  const focusNote = focusState.active
    ? '\n\nFocus activo: evitá announces ruidosos; sé breve.'
    : '\n\nFocus inactivo.';
  const telemetryNote = buildTelemetryPromptNote(
    dependencies.telemetrySnapshot,
    nowMilliseconds,
  );
  const toolDefinitionMap =
    dependencies.toolDefinitionMap ?? createBuiltinToolDefinitionMap();
  const installedToolNote = buildInstalledToolPromptNote(
    [...toolDefinitionMap.keys()].filter((toolName) => isNamespacedMcpToolName(toolName)),
  );

  // Provider-specific body fields (e.g. DeepSeek thinking-mode off) arrive as
  // a JSON env var so switching vendors never means another code change.
  let llmExtraBody: Record<string, unknown> | undefined;
  try {
    llmExtraBody =
      dependencies.environment.LLM_EXTRA_BODY !== undefined
        ? (JSON.parse(dependencies.environment.LLM_EXTRA_BODY) as Record<string, unknown>)
        : undefined;
  } catch {
    llmExtraBody = undefined;
  }

  const voiceAdapters: VoiceAdapters = isMockVoice
    ? {
        stt: async () => turnPart.text ?? 'hola',
        llm: async ({ messageList }) => {
          const userMessage = messageList.findLast((message) => message.role === 'user');
          const userText = userMessage?.role === 'user' ? userMessage.content : '';
          return {
            text: `Mock: ${userText}`,
            toolCallList: [],
          };
        },
        tts: async (text) => new TextEncoder().encode(text).buffer as ArrayBuffer,
      }
    : dependencies.environment.VOICE_PROVIDER === 'groq' ||
        dependencies.environment.VOICE_PROVIDER === 'free'
      ? {
          // Groq serves STT and TTS over plain HTTPS, so this path spends no
          // Workers AI neurons at all — the daily free allowance that kept
          // taking the whole voice loop down with it.
          stt: async (audioBuffer) =>
            transcribeAudioWithGroq({
              groqApiKey: dependencies.environment.GROQ_API_KEY ?? '',
              audioBuffer: wrapPcmAsWavBuffer({ pcmBuffer: audioBuffer }),
              ...(dependencies.environment.GROQ_STT_MODEL !== undefined
                ? { modelId: dependencies.environment.GROQ_STT_MODEL }
                : {}),
              ...(dependencies.environment.STT_LANGUAGE !== undefined
                ? { languageCode: dependencies.environment.STT_LANGUAGE }
                : {}),
            }),
          llm: async ({ messageList, toolDefinitionList, onTextDelta }) =>
            chatWithLlm({
              apiKey: dependencies.environment.LLM_API_KEY ?? '',
              modelId: dependencies.environment.LLM_MODEL ?? 'deepseek-chat',
              baseUrl:
                dependencies.environment.LLM_BASE_URL ?? 'https://api.deepseek.com',
              ...(llmExtraBody !== undefined ? { extraBody: llmExtraBody } : {}),
              messageList,
              toolDefinitionList,
              ...(onTextDelta !== undefined ? { onTextDelta } : {}),
            }),
          // Same R2 cache as every other provider: a repeated sentence is
          // served from storage instead of re-synthesised.
          // 'free' speaks through Gemini, which already emits the device's exact
          // contract (audio/L16;codec=pcm;rate=24000) and needs no model-terms
          // acceptance. 'groq' uses Orpheus, which does require it.
          tts: async (text) =>
            dependencies.environment.VOICE_PROVIDER === 'free'
              ? synthesizeSpeechThroughCache({
                  mediaBucket: dependencies.environment.MEDIA,
                  text,
                  voiceId: dependencies.environment.GEMINI_TTS_VOICE ?? 'Charon',
                  modelId:
                    dependencies.environment.GEMINI_TTS_MODEL ??
                    'gemini-2.5-flash-preview-tts',
                  synthesize: () =>
                    synthesizeSpeechWithGemini({
                      geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
                      text,
                      voiceName: dependencies.environment.GEMINI_TTS_VOICE ?? 'Charon',
                      ...(dependencies.environment.GEMINI_TTS_MODEL !== undefined
                        ? { modelId: dependencies.environment.GEMINI_TTS_MODEL }
                        : {}),
                    }),
                })
              : synthesizeSpeechThroughCache({
                  mediaBucket: dependencies.environment.MEDIA,
                  text,
                  voiceId: dependencies.environment.GROQ_TTS_VOICE ?? 'tara',
                  modelId:
                    dependencies.environment.GROQ_TTS_MODEL ??
                    'canopylabs/orpheus-v1-english',
                  synthesize: () =>
                    synthesizeSpeechWithGroq({
                      groqApiKey: dependencies.environment.GROQ_API_KEY ?? '',
                      text,
                      voice: dependencies.environment.GROQ_TTS_VOICE ?? 'tara',
                      ...(dependencies.environment.GROQ_TTS_MODEL !== undefined
                        ? { modelId: dependencies.environment.GROQ_TTS_MODEL }
                        : {}),
                    }),
                }),
        }
      : dependencies.environment.VOICE_PROVIDER === 'workersai'
        ? {
            stt: async (audioBuffer) =>
              transcribeAudioWithWorkersAi({
                ai: dependencies.environment.AI,
                audioBuffer: wrapPcmAsWavBuffer({ pcmBuffer: audioBuffer }),
                ...(dependencies.environment.STT_LANGUAGE !== undefined
                  ? { languageCode: dependencies.environment.STT_LANGUAGE }
                  : {}),
              }),
            llm: async ({ messageList, toolDefinitionList, onTextDelta }) =>
              chatWithLlm({
                apiKey: dependencies.environment.LLM_API_KEY ?? '',
                modelId: dependencies.environment.LLM_MODEL ?? 'deepseek-chat',
                baseUrl:
                  dependencies.environment.LLM_BASE_URL ?? 'https://api.deepseek.com',
                ...(llmExtraBody !== undefined ? { extraBody: llmExtraBody } : {}),
                messageList,
                toolDefinitionList,
                ...(onTextDelta !== undefined ? { onTextDelta } : {}),
              }),
            // Same R2 cache as the ElevenLabs path: repeated utterances cost zero
            // neurons. voiceId maps to an Aura speaker instead of an ElevenLabs id.
            tts: async (text) =>
              synthesizeSpeechThroughCache({
                mediaBucket: dependencies.environment.MEDIA,
                text,
                voiceId: dependencies.environment.AURA_SPEAKER ?? 'draco',
                modelId:
                  dependencies.environment.WORKERSAI_TTS_MODEL ??
                  '@cf/deepgram/aura-2-en',
                synthesize: () =>
                  synthesizeSpeechWithWorkersAi({
                    ai: dependencies.environment.AI,
                    text,
                    speaker: dependencies.environment.AURA_SPEAKER ?? 'draco',
                    ...(dependencies.environment.WORKERSAI_TTS_MODEL !== undefined
                      ? { modelId: dependencies.environment.WORKERSAI_TTS_MODEL }
                      : {}),
                  }),
              }),
          }
        : {
            stt: async (audioBuffer) =>
              transcribeAudioWithGroq({
                groqApiKey: dependencies.environment.GROQ_API_KEY ?? '',
                audioBuffer: wrapPcmAsWavBuffer({ pcmBuffer: audioBuffer }),
                ...(dependencies.environment.GROQ_STT_MODEL !== undefined
                  ? { modelId: dependencies.environment.GROQ_STT_MODEL }
                  : {}),
                ...(dependencies.environment.STT_LANGUAGE !== undefined
                  ? { languageCode: dependencies.environment.STT_LANGUAGE }
                  : {}),
              }),
            llm: async ({ messageList, toolDefinitionList, onTextDelta }) =>
              chatWithLlm({
                apiKey: dependencies.environment.LLM_API_KEY ?? '',
                modelId: dependencies.environment.LLM_MODEL ?? 'deepseek-chat',
                baseUrl:
                  dependencies.environment.LLM_BASE_URL ?? 'https://api.deepseek.com',
                messageList,
                toolDefinitionList,
                ...(onTextDelta !== undefined ? { onTextDelta } : {}),
              }),
            tts: async (text, voiceId) =>
              synthesizeApolloSpeech({
                environment: dependencies.environment,
                text,
                voiceId,
              }),
          };

  const turnOutput = await runDeskTurn({
    text: turnPart.text,
    audioBuffer: turnPart.audioBuffer,
    ...(dependencies.runBridgeCommand !== undefined
      ? { runBridgeCommand: dependencies.runBridgeCommand }
      : {}),
    speechMode: dependencies.currentState.speechMode,
    focusState,
    sqlExecutor: dependencies.sqlExecutor,
    environment: dependencies.environment,
    toolDefinitionMap,
    pendingConfirmation: turnPart.pendingConfirmation,
    confirmOk: turnPart.confirmOk,
    nowMilliseconds,
    deviceId: dependencies.deviceId,
    systemPromptOverride: `${sessionSystemPrompt}${focusNote}${telemetryNote}${installedToolNote}`,
    recentHistoryMessageList,
    ...(isMockVoice ? {} : { recallSemanticMemoryContentList }),
    effects: dependencies.effects,
    onThinkingCaption: async (caption) => {
      const liveState = dependencies.getCurrentState();
      dependencies.setAgentState({
        ...liveState,
        uiState: 'thinking',
        caption,
      });
      connection.send(
        encodeServerToDeviceMessage({
          type: 'ui_state',
          state: 'thinking',
          speechMode: liveState.speechMode,
          caption,
          emotion: resolveDeskFaceEmotion('thinking'),
          accentColor: resolveDeskSpeechMode(liveState.speechMode).accentColor,
          ...(liveState.focusEndsAt !== null
            ? {
                focusRemainingSec: Math.max(
                  0,
                  Math.ceil((liveState.focusEndsAt - Date.now()) / 1000),
                ),
                focusEndsAt: Math.floor(liveState.focusEndsAt / 1000),
                ...(liveState.focusStartedAt !== null
                  ? { focusStartedAt: Math.floor(liveState.focusStartedAt / 1000) }
                  : {}),
              }
            : {}),
        }),
      );
    },
    adapters: voiceAdapters,
  });

  for (const uiEventName of turnOutput.uiEventList) {
    dependencies.uiMachine.transition(uiEventName);
  }

  if (turnOutput.pendingConfirmation !== undefined) {
    // Persisted before confirm_request goes out below: the device can answer
    // the moment the screen appears, while the TTS at the bottom of this
    // function is still streaming, and #resolveConfirm must find it by then.
    await dependencies.persistPendingConfirmation(turnOutput.pendingConfirmation);
    await dependencies.scheduleConfirmExpiry(turnOutput.pendingConfirmation.id);
  }

  // `set_focus`/`clear_focus` tool effects (see @/agents/effects) may have
  // updated focusEndsAt on the live agent state mid-turn, ahead of the
  // uiEventList replay above. Reconcile against that live value instead of
  // the pre-turn snapshot so the tool's change isn't clobbered below, while
  // still honoring the tick-based expiry computed into turnOutput.focusState
  // when no focus tool ran this turn.
  const liveState = dependencies.getCurrentState();
  const focusChangedDuringTurn =
    liveState.focusEndsAt !== dependencies.currentState.focusEndsAt;
  const finalFocusEndsAt = focusChangedDuringTurn
    ? liveState.focusEndsAt
    : turnOutput.focusState.endsAt;
  const isFocusActiveNow =
    finalFocusEndsAt !== null && finalFocusEndsAt > nowMilliseconds;

  if (isFocusActiveNow && dependencies.uiMachine.state !== 'focus') {
    dependencies.uiMachine.transition('ENTER_FOCUS');
  } else if (!isFocusActiveNow && dependencies.uiMachine.state === 'focus') {
    dependencies.uiMachine.transition('EXIT_FOCUS');
  }

  dependencies.setAgentState({
    ...liveState,
    uiState: dependencies.uiMachine.state,
    caption: turnOutput.spokenText,
    pendingConfirmId: turnOutput.pendingConfirmation?.id ?? null,
    pendingConfirmSummary: turnOutput.pendingConfirmation?.summary ?? null,
    focusEndsAt: finalFocusEndsAt,
    focusStartedAt: finalFocusEndsAt === null ? null : liveState.focusStartedAt,
  });

  if (turnOutput.pendingConfirmation !== undefined) {
    connection.send(encodeServerToDeviceMessage({ type: 'play_effect', name: 'chime' }));
    connection.send(
      encodeServerToDeviceMessage({
        type: 'confirm_request',
        id: turnOutput.pendingConfirmation.id,
        summary: turnOutput.pendingConfirmation.summary,
        expiresAt: turnOutput.pendingConfirmation.expiresAt,
      }),
    );
  }

  let speechWasAborted = false;
  if (turnOutput.ttsAudio !== undefined) {
    const followUpSegmentTextList = turnOutput.ttsFollowUpSegmentTextList ?? [];
    let currentAudioBuffer: ArrayBuffer | undefined = turnOutput.ttsAudio;
    let followUpIndex = 0;
    let wasAborted = false;

    while (currentAudioBuffer !== undefined) {
      // The next segment renders while this one plays, so synthesis latency
      // hides behind the paced stream instead of gapping the speech. A failed
      // follow-up just ends the reply early — the turn already committed.
      const nextAudioBufferPromise: Promise<ArrayBuffer | undefined> | undefined =
        followUpIndex < followUpSegmentTextList.length
          ? voiceAdapters
              .tts(followUpSegmentTextList[followUpIndex], APOLLO_TTS_VOICE)
              .catch((error: unknown): undefined => {
                console.error(
                  JSON.stringify({
                    level: 'error',
                    message: 'apollo_tts_follow_up_segment_failed',
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
                return undefined;
              })
          : undefined;
      const isFirstSegment = followUpIndex === 0;
      followUpIndex += 1;
      const ttsSequence = dependencies.allocateTtsSequence?.();

      connection.send(
        encodeServerToDeviceMessage({
          type: 'tts_start',
          format: 'pcm',
          bytes: currentAudioBuffer.byteLength,
          ...(ttsSequence !== undefined ? { sequence: ttsSequence } : {}),
          sampleRate: TTS_PCM_SAMPLE_RATE_HZ,
          channels: TTS_PCM_CHANNEL_COUNT,
        }),
      );
      const getPlaybackAckForSequence = dependencies.getPlaybackAckForSequence;
      await streamAudioChunksAtPlaybackPace({
        audioBuffer: currentAudioBuffer,
        sampleRateHz: TTS_PCM_SAMPLE_RATE_HZ,
        channelCount: TTS_PCM_CHANNEL_COUNT,
        send: (audioChunk) => {
          connection.send(audioChunk);
        },
        // Follow-up segments land on a device that is still draining the
        // previous one, so the full 2 s burst would risk the same queue
        // overflow the pacing exists to avoid; a small allowance only
        // covers network jitter.
        ...(isFirstSegment ? {} : { prebufferMilliseconds: 500 }),
        ...(dependencies.isSpeechAborted !== undefined
          ? { shouldStop: dependencies.isSpeechAborted }
          : {}),
        ...(ttsSequence !== undefined && getPlaybackAckForSequence !== undefined
          ? { getPlaybackAck: () => getPlaybackAckForSequence(ttsSequence) }
          : {}),
      });

      if (dependencies.isSpeechAborted?.() === true) {
        wasAborted = true;
        break;
      }
      connection.send(encodeServerToDeviceMessage({ type: 'tts_end' }));
      currentAudioBuffer = await nextAudioBufferPromise;
    }

    if (wasAborted) {
      // The device counts bytes against what tts_start promised to know when
      // speech ends, and that total will never arrive now.
      connection.send(encodeServerToDeviceMessage({ type: 'tts_aborted' }));
    }
    speechWasAborted = wasAborted;
  }

  // An aborted reply never reopens the mic: the user already cut it off.
  connection.send(
    encodeServerToDeviceMessage({
      type: 'turn_end',
      expectsReply: turnOutput.expectsReply && !speechWasAborted,
    }),
  );

  if (turnOutput.transcript.length > 0) {
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: turnOutput.transcript }],
    });
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [{ type: 'text', text: turnOutput.spokenText }],
    });
  }
}

export function concatenateArrayBufferList(
  arrayBufferList: readonly ArrayBuffer[],
): ArrayBuffer {
  const totalByteLength = arrayBufferList.reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  const mergedBytes = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const buffer of arrayBufferList) {
    mergedBytes.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return mergedBytes.buffer;
}
