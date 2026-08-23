import { nextEventsTool } from '@/tools/calendar';
import { listCodingRepositoriesTool, startCodingTaskTool } from '@/tools/coding';
import { deviceStatusTool, setBrightnessTool, setVolumeTool } from '@/tools/device';
import { dollarRateTool } from '@/tools/dollar';
import { sendEmailTool } from '@/tools/email';
import { setFocusTool, clearFocusTool } from '@/tools/focus';
import { lightStatusTool, listRoomsTool, setLightTool, setSceneTool } from '@/tools/home';
import { addToListTool, readListTool, removeFromListTool } from '@/tools/list';
import { setWeatherLocationTool } from '@/tools/location';
import { recallMemoryTool, rememberFactTool } from '@/tools/memory';
import { cancelReminderTool, listRemindersTool, setReminderTool } from '@/tools/reminder';
import { buildToolDefinitionMap } from '@/tools/router';
import { startResearchTool } from '@/tools/research';
import { sandboxExecTool, sandboxRunCodeTool } from '@/tools/sandbox';
import {
  syncBoxPairTool,
  syncBoxSetAddressTool,
  syncBoxSetModeTool,
  syncBoxSetSourceTool,
  syncBoxSetSyncTool,
  syncBoxStatusTool,
} from '@/tools/syncbox';
import { setTimerTool, startPomodoroTool } from '@/tools/timer';
import { translateTool } from '@/tools/translate';
import { webSearchTool } from '@/tools/web';
import type { ToolDefinition } from '@/tools/types';
import { weatherNowTool } from '@/tools/weather';

export function listBuiltinToolDefinitionList(): readonly ToolDefinition[] {
  return [
    weatherNowTool,
    setWeatherLocationTool,
    nextEventsTool,
    rememberFactTool,
    setFocusTool,
    clearFocusTool,
    webSearchTool,
    startResearchTool,
    recallMemoryTool,
    translateTool,
    setReminderTool,
    listRemindersTool,
    cancelReminderTool,
    setTimerTool,
    startPomodoroTool,
    addToListTool,
    readListTool,
    removeFromListTool,
    dollarRateTool,
    setVolumeTool,
    setBrightnessTool,
    deviceStatusTool,
    sendEmailTool,
    sandboxRunCodeTool,
    sandboxExecTool,
    listCodingRepositoriesTool,
    startCodingTaskTool,
    listRoomsTool,
    lightStatusTool,
    setLightTool,
    setSceneTool,
    syncBoxStatusTool,
    syncBoxSetSyncTool,
    syncBoxSetModeTool,
    syncBoxSetSourceTool,
    syncBoxSetAddressTool,
    syncBoxPairTool,
  ];
}

export function createBuiltinToolDefinitionMap(): Map<string, ToolDefinition> {
  return buildToolDefinitionMap(listBuiltinToolDefinitionList());
}
