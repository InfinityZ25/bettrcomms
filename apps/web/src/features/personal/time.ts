export type ReminderPreset = 'hour' | 'eight-hours' | 'tonight' | 'tomorrow';

/** Calendar setters retain local wall time across midnight and DST changes. */
export function presetTime(preset: ReminderPreset, now = new Date()) {
  if (preset === 'hour' || preset === 'eight-hours')
    return new Date(now.getTime() + (preset === 'hour' ? 1 : 8) * 3600000);
  const next = new Date(now);
  if (preset === 'tomorrow') {
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
  } else {
    next.setHours(20, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  return next;
}

export function localDateValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function localDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${localDateValue(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function validFutureTime(value: string, now = Date.now()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > now ? date : null;
}
export function dateRange(from: string, through: string) {
  const start = from ? new Date(`${from}T00:00:00`) : null;
  const end = through ? new Date(`${through}T00:00:00`) : null;
  if (
    (start && !Number.isFinite(start.getTime())) ||
    (end && !Number.isFinite(end.getTime()))
  )
    throw new Error('Choose a valid date range.');
  if (end) end.setDate(end.getDate() + 1);
  if (start && end && start >= end)
    throw new Error('The end date must be on or after the start date.');
  return { from: start?.toISOString(), to: end?.toISOString() };
}
export function quickDateRange(
  preset: 'today' | 'yesterday' | 'week',
  now = new Date(),
) {
  const start = new Date(now);
  const end = new Date(now);
  if (preset === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (preset === 'week')
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return { from: localDateValue(start), through: localDateValue(end) };
}
