import type { RunResult } from "./types.ts";
import type { Snapshot } from "./status.ts";
export interface Operation {
  phase: "READY" | "SUBMITTED_UNVERIFIED" | "CONFIRMED" | "REJECTED";
  attempts: number;
  nextAttemptAt: number;
  result?: RunResult;
}
export interface AccountJournal {
  version: 1;
  day?: string;
  snapshot?: Snapshot;
  nextPollAt: number;
  pollFailures: number;
  reviewPending: boolean;
  events: { id: string; kind: string; at: number }[];
  operations: Record<string, Operation>;
  rebookCounts: Record<string, number>;
}
export function emptyJournal(): AccountJournal {
  return { version: 1, nextPollAt: 0, pollFailures: 0, reviewPending: false, events: [], operations: {}, rebookCounts: {} };
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
  async load(): Promise<AccountJournal> { return await this.storage.get<AccountJournal>("account-v1") ?? emptyJournal(); }
  async save(state: AccountJournal): Promise<void> { await this.storage.put("account-v1", state); }
}
