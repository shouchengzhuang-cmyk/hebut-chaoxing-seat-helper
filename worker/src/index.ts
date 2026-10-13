import { arrivalEntry } from "./arrival.ts";
import type { LifecycleCoordinator } from "./lifecycle.ts";
import { runReservation, type ReservationDependencies } from "./reservation.ts";
import { safeLog } from "./safe-log.ts";
import { cronPlan } from "./cron-plan.ts";
import type { Env } from "./types.ts";
export { SeatAccount } from "./account-object.ts";

export interface WorkerDependencies extends ReservationDependencies { coordinator?: LifecycleCoordinator }
function json(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function authorized(request: Request, env: Env): boolean { return Boolean(env.ADMIN_TOKEN) && request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`; }

async function dispatch(env: Env, dependencies: WorkerDependencies, input: { action: string; commit?: boolean; day?: string; submitAt?: number }): Promise<unknown> {
  const c = dependencies.coordinator;
  if (c) {
    if (input.action === "run") return c.run(input.commit === true, input.day, input.submitAt);
    if (input.action === "monitor") return c.tick();
    if (input.action === "schedule-missed") return c.scheduleMissed(input.day ?? "");
    if (input.action === "track") return c.track(input.day ?? "");
    return c.inspect();
  }
  if (!env.SEAT_ACCOUNT) return { kind: "STATE_STORE_REQUIRED", message: "PERSISTENT_COORDINATOR_REQUIRED" };
  const stub = env.SEAT_ACCOUNT.get(env.SEAT_ACCOUNT.idFromName("single-account-v1"));
  const response = await stub.fetch("https://account.internal/", { method: "POST", body: JSON.stringify(input) });
  if (!response.ok) throw new Error("COORDINATOR_ERROR");
  return response.json();
}
export function createWorker(dependencies: WorkerDependencies = {}): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "chaoxing-seat-reserver" });
      const routes = new Set(["POST /run", "GET /status", "POST /monitor", "POST /track", "GET /arrival"]);
      if (!routes.has(`${request.method} ${url.pathname}`)) return json({ ok: false, error: "NOT_FOUND" }, 404);
      if (!authorized(request, env)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      try {
        if (url.pathname === "/arrival") return json({ ok: true, entry: arrivalEntry(env) });
        let result: unknown;
        if (url.pathname === "/run") {
          const commit = url.searchParams.get("commit") === "1";
          // Preserve legacy dry-run behavior, with no storage binding or school writes.
          result = !commit && !url.searchParams.has("day") ? await runReservation(env, false, dependencies)
            : await dispatch(env, dependencies, { action: "run", commit, day: url.searchParams.get("day") ?? undefined });
        } else if (url.pathname === "/track") {
          const body = await request.json() as { day?: unknown };
          if (typeof body.day !== "string") return json({ ok: false, error: "INVALID_TARGET_DAY" }, 400);
          result = await dispatch(env, dependencies, { action: "track", day: body.day });
        } else result = await dispatch(env, dependencies, { action: url.pathname === "/status" ? "inspect" : "monitor" });
        const kind = (result as { kind?: string })?.kind;
        const failed = kind && !["DRY_RUN", "RESERVATION_SUCCESS", "ALREADY_RESERVED"].includes(kind);
        const status = kind === "SUBMITTED_UNVERIFIED" ? 202 : failed ? 409 : 200;
        return json({ ok: !failed, result }, status);
      } catch (error) {
        // Do not reflect upstream messages, HTML, tokens or credentials.
        const code = (error as { code?: string })?.code ?? (error instanceof Error && error.message === "JOURNAL_SCHEMA_REQUIRES_REVIEW" ? error.message : undefined);
        const allowed = ["AUTH_EXPIRED", "AUTH_OR_PAGE_INVALID", "JOURNAL_SCHEMA_REQUIRES_REVIEW"];
        const safeCode = code && allowed.includes(code) ? code : "INTERNAL_ERROR";
        safeLog("REQUEST_FAILED", { code: safeCode });
        return json({ ok: false, error: safeCode }, 500);
      }
    },
    async scheduled(controller, env): Promise<void> {
      try {
        if (controller.cron === "*/1 * * * *") {
          if (env.MONITOR_ENABLED === "true") await dispatch(env, dependencies, { action: "monitor" });
        } else if (controller.cron === "29 14 * * *" && env.WRITES_ENABLED === "true") {
          const plan = cronPlan(controller.scheduledTime, (dependencies.now?.() ?? new Date()).getTime());
          if (plan.missed) {
            await dispatch(env, dependencies, { action: "schedule-missed", day: plan.day });
            safeLog("SCHEDULED_RUN_MISSED", { day: plan.day });
            return;
          }
          if (plan.prepareDelayMs > 0) await (dependencies.wait ?? (ms => scheduler.wait(ms)))(plan.prepareDelayMs);
          const result = await dispatch(env, dependencies, { action: "run", commit: true, day: plan.day, submitAt: plan.submitAt });
          safeLog("SCHEDULED_RUN", { kind: (result as { kind?: string }).kind ?? "UNKNOWN" });
        }
      } catch { safeLog("SCHEDULED_RUN_FAILED", { code: "COORDINATOR_ERROR" }); }
    },
  };
}
export default createWorker();
