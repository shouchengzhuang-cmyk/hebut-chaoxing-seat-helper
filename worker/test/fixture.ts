import { SerialJournal, type JournalStorage } from "../src/journal.ts";
import { LifecycleCoordinator } from "../src/lifecycle.ts";
import type { Env } from "../src/types.ts";
// Synthetic contract: these codes and policy fields are NOT HEBUT evidence.
export const day = "2026-10-14";
export const record = { id: 123, roomId: 3747, seatNum: "216", today: day, startTime: "08:30", endTime: "22:00", status: "pending-fixture" };
export const profile = { states: { "pending-fixture": "RESERVED_PENDING", "signed-fixture": "SIGNED_IN", "review-fixture": "REVIEW_REQUIRED", "released-fixture": "RELEASED", "completed-fixture": "COMPLETED" }, policyFields: { allowed: "data.rules.canReserve", supervisionPending: "data.rules.reviewPending", blacklisted: "data.rules.blacklisted", seatAvailable: "data.rules.seatAvailable" } };
export const env: Env = { CHAOOXING_COOKIE: "FAKE_COOKIE", CHAOOXING_RESERVE_PAGE_URL: "https://office.chaoxing.com/front/third/apps/seat/select?id=3747", CHAOOXING_HALL_URL: "https://office.chaoxing.com/front/third/apps/seat/index", ADMIN_TOKEN: "FAKE_ADMIN", FID_ENC: "FAKE_FID", WRITES_ENABLED: "true", STATUS_PROFILE_VERIFIED: "true", STATUS_PROFILE_JSON: JSON.stringify(profile) };
export const page = '<input id="submit_enc" value="FAKE_SALT">';
export const rules = { canReserve: true, reviewPending: false, blacklisted: false, seatAvailable: true };
export function index(records: unknown[] = [], policy?: typeof rules) { return { success: true, data: { curReserves: records, nearReserves: [], ...(policy ? { rules: policy } : {}) } }; }
export class MemoryStorage implements JournalStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
}
export function harness(responses: (unknown | Error | ((url: string, init: RequestInit) => Promise<Response>))[], overrides: Partial<Env> = {}, storage = new MemoryStorage()) {
  const calls: { url: string; init: RequestInit }[] = [];
  let now = Date.parse("2026-10-13T05:32:00Z");
  const deps = { now: () => new Date(now), timeoutMs: 50, fetchImpl: async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (!responses.length) throw new Error("UNEXPECTED_MOCK_REQUEST");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "function") return response(url, init);
    return new Response(typeof response === "string" ? response : JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  } };
  const config = { ...env, ...overrides }, journal = new SerialJournal(storage);
  return { calls, deps, storage, journal, config, c: new LifecycleCoordinator(config, journal, deps), advance: (ms: number) => { now += ms; }, writes: () => calls.filter(call => call.url.endsWith("/submit")) };
}
