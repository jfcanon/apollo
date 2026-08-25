import { z } from 'zod';

import { googleFetch } from '@/google/oauth';
import { APOLLO_TIME_ZONE } from '@/persona/clock';

const PRIMARY_CALENDAR_ID = 'primary';

// A Calendar event carries either dateTime (a timed event) or date (an all-day
// event); never both. The all-day form is a bare YYYY-MM-DD with no offset, so
// parsing it as an instant would silently shift the day across the UTC-3
// boundary — which is the single most likely bug in this file.
const googleEventTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const googleEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  start: googleEventTimeSchema.optional(),
  end: googleEventTimeSchema.optional(),
});

const googleEventListSchema = z.object({
  items: z.array(googleEventSchema).optional(),
});

export type UpcomingCalendarEvent = {
  readonly id: string;
  readonly title: string;
  readonly isAllDay: boolean;
  readonly startIso: string;
  readonly spokenWhen: string;
};

export type UpcomingCalendarEventListResult =
  | { readonly ok: true; readonly eventList: readonly UpcomingCalendarEvent[] }
  | { readonly ok: false; readonly error: string };

export function formatCalendarEventWhen(
  event: z.infer<typeof googleEventSchema>,
  nowMilliseconds: number,
): {
  readonly isAllDay: boolean;
  readonly startIso: string;
  readonly spokenWhen: string;
} {
  const allDayDate = event.start?.date;
  if (allDayDate !== undefined) {
    return {
      isAllDay: true,
      startIso: allDayDate,
      spokenWhen: formatAllDayLabel(allDayDate, nowMilliseconds),
    };
  }
  const startIso = event.start?.dateTime ?? '';
  return {
    isAllDay: false,
    startIso,
    spokenWhen: formatTimedLabel(startIso, nowMilliseconds),
  };
}

function formatDayKeyInApolloZone(dateInstant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APOLLO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dateInstant);
}

function describeRelativeDay(
  eventDayKey: string,
  nowMilliseconds: number,
): string | null {
  const todayKey = formatDayKeyInApolloZone(new Date(nowMilliseconds));
  const tomorrowKey = formatDayKeyInApolloZone(new Date(nowMilliseconds + 86_400_000));
  if (eventDayKey === todayKey) {
    return 'hoy';
  }
  if (eventDayKey === tomorrowKey) {
    return 'mañana';
  }
  return null;
}

function formatWeekdayAndDay(dateInstant: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: APOLLO_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(dateInstant);
}

function formatAllDayLabel(allDayDate: string, nowMilliseconds: number): string {
  // Anchor the bare date at midday UTC so neither a UTC-3 nor a UTC+n rendering
  // can roll it onto the neighbouring day.
  const middayInstant = new Date(`${allDayDate}T12:00:00Z`);
  const relativeDay = describeRelativeDay(allDayDate, nowMilliseconds);
  const dayLabel = relativeDay ?? formatWeekdayAndDay(middayInstant);
  return `${dayLabel}, todo el día`;
}

function formatTimedLabel(startIso: string, nowMilliseconds: number): string {
  const startInstant = new Date(startIso);
  if (Number.isNaN(startInstant.getTime())) {
    return 'sin horario';
  }
  const timeLabel = new Intl.DateTimeFormat('es-AR', {
    timeZone: APOLLO_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(startInstant);
  const relativeDay = describeRelativeDay(
    formatDayKeyInApolloZone(startInstant),
    nowMilliseconds,
  );
  const dayLabel = relativeDay ?? formatWeekdayAndDay(startInstant);
  return `${dayLabel} a las ${timeLabel}`;
}

export async function listUpcomingCalendarEvents(input: {
  readonly environment: Env;
  readonly nowMilliseconds: number;
  readonly maxResultCount?: number;
  readonly windowDays?: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<UpcomingCalendarEventListResult> {
  const maxResultCount = input.maxResultCount ?? 5;
  const windowDays = input.windowDays ?? 7;
  const searchParameters = new URLSearchParams({
    timeMin: new Date(input.nowMilliseconds).toISOString(),
    timeMax: new Date(input.nowMilliseconds + windowDays * 86_400_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResultCount),
    // Makes Google return dateTime values already offset to Buenos Aires, so a
    // spoken 15:00 matches the phone without a second conversion here.
    timeZone: APOLLO_TIME_ZONE,
  });
  const requestPath = `/calendar/v3/calendars/${PRIMARY_CALENDAR_ID}/events?${searchParameters.toString()}`;

  const fetched = await googleFetch(input.environment, requestPath, {
    nowMilliseconds: input.nowMilliseconds,
    ...(input.fetchImplementation !== undefined
      ? { fetchImplementation: input.fetchImplementation }
      : {}),
  });
  if (!fetched.ok) {
    return { ok: false, error: fetched.error };
  }
  if (!fetched.response.ok) {
    return {
      ok: false,
      error: `google calendar returned ${fetched.response.status}`,
    };
  }

  const parsed = googleEventListSchema.safeParse(await fetched.response.json());
  if (!parsed.success) {
    return { ok: false, error: 'google calendar returned an unreadable payload' };
  }

  const eventList = (parsed.data.items ?? [])
    .filter((event) => event.status !== 'cancelled')
    .map((event) => {
      const when = formatCalendarEventWhen(event, input.nowMilliseconds);
      return {
        id: event.id,
        title: event.summary ?? 'Sin título',
        isAllDay: when.isAllDay,
        startIso: when.startIso,
        spokenWhen: when.spokenWhen,
      };
    });

  return { ok: true, eventList };
}
