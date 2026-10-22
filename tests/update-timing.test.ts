import { expect, test } from 'bun:test';
import { nextUpdateAt, updateRuleInput } from '../src/core/library/update-timing';

test('calendar rules use the selected timezone and keep fixed times after missed days', () => {
  const timing = { kind: 'daily', time: '08:00', timezone: 'Asia/Shanghai' } as const;
  expect(new Date(nextUpdateAt(timing, Date.UTC(2026, 9, 22, 23, 59))).toISOString()).toBe('2026-10-23T00:00:00.000Z');
  expect(new Date(nextUpdateAt(timing, Date.UTC(2026, 9, 23, 0))).toISOString()).toBe('2026-10-24T00:00:00.000Z');
  const weekly = { kind: 'weekly', time: '08:00', timezone: 'Asia/Shanghai', weekdays: [1, 5] } as const;
  expect(new Date(nextUpdateAt({ ...weekly, weekdays: [...weekly.weekdays] }, Date.UTC(2026, 9, 23, 1))).toISOString()).toBe('2026-10-26T00:00:00.000Z');
});

test('calendar input normalizes weekdays and rejects unusable time fields', () => {
  const input = { instanceId: 'source', enabled: true, target: { kind: 'instance' },
    timing: { kind: 'weekly', time: '08:00', timezone: 'Asia/Shanghai', weekdays: [5, 1, 5] } };
  expect(updateRuleInput.parse(input).timing).toEqual({ kind: 'weekly', time: '08:00', timezone: 'Asia/Shanghai', weekdays: [1, 5] });
  expect(updateRuleInput.safeParse({ ...input, timing: { kind: 'daily', time: '25:00', timezone: 'Asia/Shanghai' } }).success).toBe(false);
  expect(updateRuleInput.safeParse({ ...input, timing: { kind: 'daily', time: '08:00', timezone: 'invalid' } }).success).toBe(false);
});
