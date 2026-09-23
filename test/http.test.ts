import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../src/server.js";
import { runMigrations } from "../src/db.js";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const app = createApp(db);
  return { db, app };
}

async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; text: string }> {
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  } finally {
    server.close();
  }
}

test("健康检查", async () => {
  const { app } = setup();
  const r = await call(app, "GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("完整灰度旅程经由 HTTP：建波→认领→签到→片段→封账→迟到片→比较→双签→报告/反查", async () => {
  const { app } = setup();

  assert.equal((await call(app, "POST", "/admin/firmwares", { firmwareId: "fw-old", digest: "sha256:old", versionLabel: "v1" })).status, 200);
  assert.equal((await call(app, "POST", "/admin/firmwares", { firmwareId: "fw-new", digest: "sha256:new", versionLabel: "v2" })).status, 200);
  assert.equal(
    (
      await call(app, "POST", "/admin/rules", {
        ruleId: "r-inc",
        role: "incumbent",
        label: "现行",
        payload: { priceCentsPerKwh: 100, roundingMode: "round", resetPolicy: "passthrough", resetToleranceKwh: 50 },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await call(app, "POST", "/admin/rules", {
        ruleId: "r-cand",
        role: "candidate",
        label: "候选",
        payload: { priceCentsPerKwh: 100, roundingMode: "round", resetPolicy: "clamp_zero", resetToleranceKwh: 50 },
      })
    ).status,
    200
  );
  assert.equal(
    (await call(app, "POST", "/admin/devices", { deviceId: "D1", siteId: "S1", model: "M1", calibrationBatch: "B1" })).status,
    200
  );
  assert.equal(
    (
      await call(app, "POST", "/waves", {
        waveId: "W1",
        name: "波次一",
        siteIds: ["S1"],
        deviceModels: ["M1"],
        calibrationBatches: ["B1"],
        incumbentRuleId: "r-inc",
        candidateRuleId: "r-cand",
        candidateFirmwareId: "fw-new",
        thresholds: { maxNegativeRate: 0.05, maxMissingRate: 0.2, minSessions: 1, maxAmountDiffRel: 0.05 },
      })
    ).status,
    200
  );

  const claim = await call(app, "POST", "/waves/W1/claim", { deviceId: "D1" });
  assert.equal(claim.body.outcome, "claimed");

  const checkin = await call(app, "POST", "/devices/D1/checkins", {
    firmwareId: "fw-new",
    idempotencyKey: "ck1",
    installedAt: "2026-09-20T08:00:00Z",
    reportedAt: "2026-09-20T08:01:00Z",
  });
  assert.equal(checkin.body.isCandidate, true);
  const checkinDup = await call(app, "POST", "/devices/D1/checkins", {
    firmwareId: "fw-new",
    idempotencyKey: "ck1",
    installedAt: "2026-09-20T08:00:00Z",
    reportedAt: "2026-09-20T08:01:00Z",
  });
  assert.equal(checkinDup.body.duplicate, true);

  const frags = await call(app, "POST", "/devices/D1/fragments", [
    {
      fragmentId: "f1",
      idempotencyKey: "k1",
      seq: 1,
      clientSessionId: "cs1",
      startedAt: "2026-09-20T09:00:00Z",
      endedAt: "2026-09-20T09:30:00Z",
      readingStart: 0,
      readingEnd: 12,
      firmwareId: "fw-new",
    },
  ]);
  assert.equal(frags.body.accepted, 1);

  assert.equal((await call(app, "POST", "/periods/2026-09-20/close")).status, 200);

  // 迟到片
  const late = await call(app, "POST", "/devices/D1/fragments", [
    {
      fragmentId: "f2",
      idempotencyKey: "k2",
      seq: 2,
      clientSessionId: "cs1",
      startedAt: "2026-09-20T10:00:00Z",
      endedAt: "2026-09-20T10:30:00Z",
      readingStart: 12,
      readingEnd: 20,
      firmwareId: "fw-new",
    },
  ]);
  assert.equal(late.body.late, 1);

  const cmp = await call(app, "POST", "/waves/W1/compare");
  assert.equal(cmp.body.interrupted, false);

  // 比较未中断语义：crashAfter 续算
  // （再调一次应幂等）
  const cmp2 = await call(app, "POST", "/waves/W1/compare");
  assert.equal(cmp2.body.processed, 0);

  const a1 = await call(app, "POST", "/waves/W1/approvals", { role: "metering", approver: "张计量", decision: "approve" });
  assert.equal(a1.body.promoted, false);
  const a2 = await call(app, "POST", "/waves/W1/approvals", { role: "clearing", approver: "李清算", decision: "approve" });
  assert.equal(a2.body.promoted, true);

  const report = await call(app, "GET", "/waves/W1/report");
  assert.equal(report.status, 200);
  assert.equal(report.body.summary.conservationOk, true);
  assert.equal(report.body.devices.promote[0].deviceId, "D1");
  assert.ok(report.body.adjustments.length >= 1);

  const md = await call(app, "GET", "/waves/W1/report?format=markdown");
  assert.equal(md.status, 200);
  assert.match(md.text, /固件灰度结算报告/);

  const sessionId = report.body.risk.topSessions[0].sessionId;
  const trace = await call(app, "GET", `/waves/W1/sessions/${sessionId}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.firmware[0].digest, "sha256:new");
  assert.equal(trace.body.rules.length, 2);
  assert.equal(trace.body.readingRange.fragments.length, 2);
  assert.equal(trace.body.approvals.length, 2);
});

test("越界认领与坏请求返回结构化错误", async () => {
  const { app } = setup();
  await call(app, "POST", "/admin/firmwares", { firmwareId: "fw-new", digest: "x", versionLabel: "v2" });
  await call(app, "POST", "/admin/rules", {
    ruleId: "r-inc",
    role: "incumbent",
    label: "i",
    payload: { priceCentsPerKwh: 100, roundingMode: "round", resetPolicy: "passthrough", resetToleranceKwh: 50 },
  });
  await call(app, "POST", "/admin/rules", {
    ruleId: "r-cand",
    role: "candidate",
    label: "c",
    payload: { priceCentsPerKwh: 100, roundingMode: "round", resetPolicy: "clamp_zero", resetToleranceKwh: 50 },
  });
  await call(app, "POST", "/admin/devices", { deviceId: "D1", siteId: "S9", model: "M1", calibrationBatch: "B1" });
  await call(app, "POST", "/waves", {
    waveId: "W1",
    name: "w",
    siteIds: ["S1"],
    deviceModels: ["M1"],
    calibrationBatches: ["B1"],
    incumbentRuleId: "r-inc",
    candidateRuleId: "r-cand",
    candidateFirmwareId: "fw-new",
    thresholds: { maxNegativeRate: 0.05, maxMissingRate: 0.2, minSessions: 1, maxAmountDiffRel: 0.05 },
  });
  const r = await call(app, "POST", "/waves/W1/claim", { deviceId: "D1" });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "OUT_OF_WAVE_SCOPE");

  const bad = await call(app, "POST", "/devices/D1/fragments", "{not-json}", {});
  assert.equal(bad.status, 400);
});
