import { getTomorrowInShanghai } from "./time.ts";
export function cronPlan(scheduledTime: number, now: number): { day: string; submitAt: number; prepareDelayMs: number; missed: boolean } {
  if (!Number.isFinite(scheduledTime) || !Number.isFinite(now)) throw new Error("INVALID_CRON_TIME");
  const submitAt = scheduledTime + 60000;
  // Anchor the target day to the scheduled occurrence, not the delayed worker's wall clock.
  return { day: getTomorrowInShanghai(new Date(scheduledTime)), submitAt, prepareDelayMs: Math.max(0, submitAt - now - 5000), missed: now > submitAt + 15 * 60000 };
}
