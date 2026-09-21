import { logRunResult, prepareReservation, runReservation, submitPreparedReservation, type ReservationDependencies } from "./reservation.ts";
import { sanitizeError, safeLog } from "./safe-log.ts";
import type { Env, RunResult } from "./types.ts";

export interface WorkerDependencies extends ReservationDependencies {}

function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } }); }
function authorized(request: Request, env: Env): boolean { return Boolean(env.ADMIN_TOKEN) && request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`; }
function publicResult(result: RunResult): Record<string, unknown> {
  if (result.kind === "DRY_RUN") return result;
  if (result.kind === "RESERVATION_SUCCESS" || result.kind === "ALREADY_RESERVED") return result;
  return "message" in result ? { kind: result.kind, ...(result.targetDay ? { targetDay: result.targetDay } : {}), message: result.message } : { kind: result.kind };
}

async function scheduledRun(env: Env, scheduledTime: number, dependencies: WorkerDependencies): Promise<void> {
  const wait = dependencies.wait ?? ((milliseconds: number) => scheduler.wait(milliseconds));
  const targetTime = scheduledTime + 60_000;
  const initialDelay = targetTime - Date.now() - 5_000;
  if (initialDelay > 0) await wait(initialDelay);
  // Fetch immediately before the target; token is never cached across days or attempts.
  const prepared = await prepareReservation(env, dependencies);
  const finalDelay = targetTime - Date.now();
  if (finalDelay > 0) await wait(finalDelay);
  const result = await submitPreparedReservation(env, prepared, { ...dependencies, wait });
  logRunResult(result);
}

export function createWorker(dependencies: WorkerDependencies = {}): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "chaoxing-seat-reserver" });
      if (request.method === "POST" && url.pathname === "/run") {
        if (!authorized(request, env)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
        try {
          const result = await runReservation(env, url.searchParams.get("commit") === "1", dependencies);
          logRunResult(result);
          return json({ ok: result.kind === "DRY_RUN" || result.kind === "RESERVATION_SUCCESS" || result.kind === "ALREADY_RESERVED", result: publicResult(result) }, result.kind === "RESERVATION_FAILED" ? 422 : 200);
        } catch (error) {
          const safe = sanitizeError(error); safeLog("RUN_FAILED", safe);
          return json({ ok: false, error: (error as { code?: string })?.code ?? "INTERNAL_ERROR", message: safe.message }, safe.status ?? 500);
        }
      }
      return json({ ok: false, error: "NOT_FOUND" }, 404);
    },
    async scheduled(controller, env): Promise<void> {
      try { await scheduledRun(env, controller.scheduledTime, dependencies); }
      catch (error) { const safe = sanitizeError(error); safeLog("SCHEDULED_RUN_FAILED", safe); }
    },
  };
}

export default createWorker();
