import { PlanCoordinator, type AccountAction } from "./plan-coordinator.ts";
import { PlanError } from "./plans.ts";
import type { Env } from "./types.ts";

// SQLite-backed DO is needed for concurrent /run + Cron and restart-safe unresolved writes.
// One fixed object per deployment/account; no credentials are stored in the journal.
export class SeatAccount {
  private readonly coordinator: PlanCoordinator;
  constructor(state: DurableObjectState, env: Env) {
    this.coordinator = new PlanCoordinator(env, state.storage);
  }
  async fetch(request: Request): Promise<Response> {
    try { return Response.json(await this.coordinator.dispatch(await request.json() as AccountAction)); }
    catch (error) {
      if (error instanceof PlanError) return Response.json({ error: error.code }, { status: error.status });
      throw error;
    }
  }
}
