import { Cron } from 'croner';
import { z } from 'zod';
import type { UpdateRuleInput, UpdateTiming } from '../../contracts/refresh-policy';

const timezone = z.string().min(1).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid timezone');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const updateRuleInput = z.object({
  instanceId: z.string().min(1), enabled: z.boolean(), label: z.string().trim().min(1).max(240).optional(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('instance') }).strict(), z.object({ kind: z.literal('roots') }).strict(),
    z.object({ kind: z.literal('directory'), directoryRef: z.string(), recursive: z.boolean() }).strict()
  ]),
  timing: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('interval'), minutes: z.number().int().min(15).max(525_600) }).strict(),
    z.object({ kind: z.literal('daily'), time, timezone }).strict(),
    z.object({ kind: z.literal('weekly'), time, timezone, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .transform(days => [...new Set(days)].sort()) }).strict()
  ])
}).strict().transform(({ label, ...value }): UpdateRuleInput => ({ ...value, ...(label === undefined ? {} : { label }) }));

/** Croner calculates calendar instants only; persisted host work owns all timers and execution. */
export function nextUpdateAt(timing: UpdateTiming, after: number): number {
  if (timing.kind === 'interval') return after + timing.minutes * 60_000;
  const [hour, minute] = timing.time.split(':');
  const cron = new Cron(`${minute} ${hour} * * ${timing.kind === 'weekly' ? timing.weekdays.join(',') : '*'}`,
    { paused: true, timezone: timing.timezone });
  const next = cron.nextRun(new Date(after));
  if (!next) throw new Error('No next update instant');
  return next.getTime();
}
