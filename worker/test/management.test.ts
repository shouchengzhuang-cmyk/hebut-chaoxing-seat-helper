import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { publicResult, readManagementJson } from "../src/management.ts";
import { controlPage, controlScript } from "../src/control-page.ts";
import { createWorker } from "../src/index.ts";
import { env } from "./fixture.ts";

const invoke = (request: Request) => createWorker().fetch!(request, env, {} as ExecutionContext) as Promise<Response>;
test("control page has CSP, no frames, no credential storage and valid JavaScript", async () => {
  const response = controlPage(), html = await response.text();
  assert.equal(response.headers.get("X-Frame-Options"), "DENY"); assert.match(response.headers.get("Content-Security-Policy")!, /connect-src 'self'/);
  assert.doesNotMatch(html, /FAKE_ADMIN|FAKE_COOKIE|localStorage|sessionStorage|unsafe-inline/); assert.match(html, /type="password"/);
  assert.doesNotThrow(() => new vm.Script(controlScript));
});
for (const [method, path] of [["GET", "/plans"], ["PUT", "/plans"], ["POST", "/preview"], ["POST", "/checkin"]])
  test(`${method} ${path} requires bearer authentication`, async () => {
    assert.equal((await invoke(new Request("https://worker.example" + path, { method }))).status, 401);
  });
for (const origin of ["https://office.chaoxing.com", "https://evil.example", "null"])
  test(`management rejects origin ${origin}`, async () => {
    const response = await invoke(new Request("https://worker.example/plans", { headers: { Authorization: "Bearer FAKE_ADMIN", Origin: origin } }));
    assert.equal(response.status, 403); assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  });
test("query credentials and cross-site fetch are rejected", async () => {
  assert.equal((await invoke(new Request("https://worker.example/plans?token=PRIVATE", { headers: { Authorization: "Bearer FAKE_ADMIN" } }))).status, 400);
  assert.equal((await invoke(new Request("https://worker.example/plans", { headers: { Authorization: "Bearer FAKE_ADMIN", "Sec-Fetch-Site": "cross-site" } }))).status, 403);
  assert.equal((await invoke(new Request("https://worker.example/plans", { method: "OPTIONS" }))).status, 404);
});
test("bounded JSON reading rejects large streams, malformed JSON and primitive bodies", async () => {
  for (const [body, code] of [["x".repeat(17000), "BODY_TOO_LARGE"], ["PRIVATE_INVALID", "INVALID_JSON"], ["null", "INVALID_BODY"], ["[]", "INVALID_BODY"]]) {
    await assert.rejects(() => readManagementJson(new Request("https://worker.example/plans", { method: "PUT", headers: { "Content-Type": "application/json" }, body })), new RegExp(code));
  }
});
test("management errors never reflect malformed body contents", async () => {
  const r = await invoke(new Request("https://worker.example/plans", { method: "PUT", headers: { Authorization: "Bearer FAKE_ADMIN", "Content-Type": "application/json" }, body: "PRIVATE_SENTINEL" }));
  assert.equal(r.status, 400); assert.doesNotMatch(await r.text(), /PRIVATE_SENTINEL/);
});
test("public projection strips reservation IDs and raw status throughout archives and operations", () => {
  const result = publicResult({ snapshot: { record: { id: "987654321", roomId: "3747", day: "2026-10-14", rawStatus: "PRIVATE_STATUS" } },
    operations: { "day|released:987654321": { result: { reserveId: "987654321" } } }, events: [{ id: "review:987654321", kind: "REVIEW_REQUIRED", at: 1 }],
    checkin: { operationId: "checkin:987654321" } });
  assert.doesNotMatch(JSON.stringify(result), /987654321|PRIVATE_STATUS|rawStatus/);
});
