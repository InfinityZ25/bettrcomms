import { describe, expect, it } from 'vitest';
import {
  dateRange,
  localDateValue,
  presetTime,
  quickDateRange,
  validFutureTime,
} from './time';

describe('personal reminder and search dates', () => {
  it('chooses future evening and morning instants using calendar dates rather than fixed 24-hour offsets', () => {
    const late = new Date(2026, 9, 11, 21, 30);
    const evening = presetTime('tonight', late);
    const morning = presetTime('tomorrow', late);
    expect(evening.getDate()).toBe(12);
    expect(evening.getHours()).toBe(20);
    expect(morning.getDate()).toBe(12);
    expect(morning.getHours()).toBe(9);
    expect(presetTime('hour', late).getTime() - late.getTime()).toBe(3600000);
  });
  it('includes the whole local through day in the exclusive UTC end boundary', () => {
    const range = dateRange('2026-10-10', '2026-10-11');
    expect(new Date(range.from!).getHours()).toBe(0);
    expect(localDateValue(new Date(range.to!))).toBe('2026-10-12');
    expect(new Date(range.to!).getHours()).toBe(0);
    expect(() => dateRange('2026-10-12', '2026-10-11')).toThrow();
  });
  it('uses Monday as the start of this week, including on Sunday', () => {
    expect(quickDateRange('week', new Date(2026, 9, 11, 12))).toEqual({
      from: '2026-10-05',
      through: '2026-10-11',
    });
    expect(quickDateRange('yesterday', new Date(2026, 0, 1, 12))).toEqual({
      from: '2025-12-31',
      through: '2025-12-31',
    });
  });
  it('rejects invalid and elapsed custom reminder dates', () => {
    expect(validFutureTime('invalid')).toBeNull();
    expect(
      validFutureTime('2026-10-10T00:00', new Date(2026, 9, 11).getTime()),
    ).toBeNull();
  });
});
