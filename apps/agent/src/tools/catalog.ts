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
  syncBoxSetSyncTool,
  syncBoxSetSourceTool,
  syncBoxStatusTool,
} from '@/tools/syncbox';
import { setTimerTool, startPomodoroTool } from '@/tools/timer';
import { timonCreateTaskTool } from '@/tools/timon';
import { translateTool } from '@/tools/translate';
import { webSearchTool } from '@/tools/web';
import type { ToolDefinition } from '@/tools/types';
import { weatherNowTool } from '@/tools/weather';

const COMPACT_CATALOG_TOOL_NAMES = new Set([
  'timon_create_task',
  'remember_fact',
  'recall_memory',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'set_timer',
  'start_pomodoro',
  'weather_now',
  'set_weather_location',
  'next_events',
  'device_status',
  'set_focus',
  'clear_focus',
]);

function filterCompactCatalog(
  toolList: readonly ToolDefinition[],
): readonly ToolDefinition[] {
  return toolList.filter((tool) => COMPACT_CATALOG_TOOL_NAMES.has(tool.name));
}

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
    timonCreateTaskTool,
  ];
}

export function listCompactToolDefinitionList(): readonly ToolDefinition[] {
  return filterCompactCatalog(listBuiltinToolDefinitionList());
}

export function createBuiltinToolDefinitionMap(): Map<string, ToolDefinition> {
  return buildToolDefinitionMap(listBuiltinToolDefinitionList());
}

export function createCompactToolDefinitionMap(): Map<string, ToolDefinition> {
  return buildToolDefinitionMap(listCompactToolDefinitionList());
}
