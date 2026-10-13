import { SerialJournal } from "./journal.ts";
import { LifecycleCoordinator } from "./lifecycle.ts";
import type { Env } from "./types.ts";

// SQLite-backed DO is needed for concurrent /run + Cron and restart-safe unresolved writes.
// One fixed object per deployment/account; no credentials are stored in the journal.
export class SeatAccount {
  private readonly coordinator: LifecycleCoordinator;
  constructor(state: DurableObjectState, env: Env) {
    this.coordinator = new LifecycleCoordinator(env, new SerialJournal(state.storage));
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { action?: string; commit?: boolean; day?: string; submitAt?: number };
    let result: unknown;
    switch (input.action) {
      case "run": result = await this.coordinator.run(input.commit === true, input.day, input.submitAt); break;
      case "monitor": result = await this.coordinator.tick(); break;
      case "schedule-missed": result = await this.coordinator.scheduleMissed(input.day ?? ""); break;
      case "track": result = await this.coordinator.track(input.day ?? ""); break;
      case "inspect": result = await this.coordinator.inspect(); break;
      default: return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
    }
    return Response.json(result);
  }
}
