import assert from "node:assert/strict";
import test from "node:test";
import { createWorker } from "../src/index.ts";
import type { Env } from "../src/types.ts";

const env: Env = {
  CHAOOXING_COOKIE: "test-cookie-not-a-real-credential",
  CHAOOXING_RESERVE_PAGE_URL: "https://office.chaoxing.com/front/third/apps/seat/select?test=1",
  ADMIN_TOKEN: "test-admin-token",
};

test("health is public", async () => {
  const response = await createWorker().fetch(new Request("https://worker.example/health"), env, {} as ExecutionContext);
  assert.deepEqual(await response.json(), { ok: true, service: "chaoxing-seat-reserver" });
});

test("run requires the admin bearer token", async () => {
  let calls = 0;
  const worker = createWorker({ fetchImpl: async () => { calls += 1; return new Response("unexpected"); } });
  const response = await worker.fetch(new Request("https://worker.example/run", { method: "POST" }), env, {} as ExecutionContext);
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test("dry run reads the page but never calls the submit endpoint", async () => {
  const urls: string[] = [];
  const worker = createWorker({ fetchImpl: async (input) => {
    const url = String(input); urls.push(url);
    return new Response('<input value="test-submit-salt" id="submit_enc" type="hidden">', { status: 200, headers: { "Content-Type": "text/html" } });
  }, now: () => new Date("2026-09-21T14:30:00.000Z") });
  const response = await worker.fetch(new Request("https://worker.example/run", { method: "POST", headers: { Authorization: "Bearer test-admin-token" } }), env, {} as ExecutionContext);
  const body = await response.json() as { ok: boolean; result: { kind: string; encGenerated: boolean; targetDay: string } };
  assert.equal(response.status, 200); assert.equal(body.ok, true); assert.equal(body.result.kind, "DRY_RUN"); assert.equal(body.result.encGenerated, true); assert.equal(body.result.targetDay, "2026-09-22");
  assert.deepEqual(urls, [env.CHAOOXING_RESERVE_PAGE_URL]);
});
