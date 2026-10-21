/** A missing policy is manual; persisted timers never imply recursive or whole-instance refresh. */
export type RefreshPolicy = { intervalMinutes: number; nextRunAt: string | null };
