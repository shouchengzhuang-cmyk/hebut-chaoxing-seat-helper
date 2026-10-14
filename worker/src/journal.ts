import type { RunResult, ReservationTarget } from "./types.ts";
import type { Snapshot } from "./status.ts";
export type AuthorizationSource = "MANUAL" | "CRON" | "REBOOK";
export interface Operation {
  phase: "READY" | "SUBMITTED_UNVERIFIED" | "CONFIRMED" | "REJECTED";
  attempts: number;
  nextAttemptAt: number;
  // Retain the original Cron authorization across retries and restarts.
  submitAt?: number;
  authorizationSource?: AuthorizationSource;
  result?: RunResult;
}
export interface ArchivedLifecycle {
  day: string;
  target: ReservationTarget;
  snapshot?: Snapshot;
  archivedAt: number;
  reason: "SERVER_TERMINAL" | "LOCAL_TASK_INTERVAL_ENDED";
  // Local archival never invents a server completion/release.
  serverTerminalConfirmed: boolean;
  operations: Record<string, Operation>;
}
export interface Handoff {
  targetDay: string;
  reason: string;
  attempts: number;
  nextCheckAt: number;
  needsHuman: boolean;
}
export interface AccountJournal {
  version: 1;
  day?: string;
  target?: ReservationTarget;
  archives: ArchivedLifecycle[];
  handoff?: Handoff;
  pendingRun?: { day: string; submitAt?: number; authorizationSource?: AuthorizationSource };
  snapshot?: Snapshot;
  nextPollAt: number;
  pollFailures: number;
  reviewPending: boolean;
  events: { id: string; kind: string; at: number }[];
  operations: Record<string, Operation>;
  rebookCounts: Record<string, number>;
}
export function emptyJournal(): AccountJournal {
  return { version: 1, archives: [], nextPollAt: 0, pollFailures: 0, reviewPending: false, events: [], operations: {}, rebookCounts: {} };
}
export interface JournalStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
// Explicit queue remains held across network awaits. Durable Object input gates alone are insufficient.
export class SerialJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly storage: JournalStorage;
  constructor(storage: JournalStorage) { this.storage = storage; }
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async load(): Promise<AccountJournal> {
    const state = await this.storage.get<AccountJournal>("account-v1");
    if (!state) return emptyJournal();
    if (state.version !== 1 || !state.operations || !Array.isArray(state.events)) throw new Error("JOURNAL_SCHEMA_REQUIRES_REVIEW");
    // Additive migration preserves every existing operation and review latch in account-v1.
    return { ...state, archives: state.archives ?? [] };
  }
  async save(state: AccountJournal): Promise<void> { await this.storage.put("account-v1", state); }
}
