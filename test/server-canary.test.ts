import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { newMemoryDb } from "./helpers.js";
import { seedDemo } from "../scripts/demo.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const db = newMemoryDb();
  seedDemo(db);
  const server = createServer(createApp({ db }).callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test("GET /health", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { status: string }).status, "ok");
  });
});

test("报告接口返回裁决与守恒结论", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/waves/W-2026-09-22/report`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      totals: { promote: number; quarantine: number; blocked: number };
      checks: Array<{ passed: boolean }>;
    };
    assert.equal(body.totals.promote, 2);
    assert.equal(body.totals.quarantine, 3);
    assert.equal(body.totals.blocked, 1);
    assert.ok(body.checks.every((c) => c.passed));

    const md = await (await fetch(`${base}/waves/W-2026-09-22/report.md`)).text();
    assert.match(md, /计量固件灰度报告/);
    assert.match(md, /必须隔离/);
  });
});

test("差异反查接口返回固件→规则→读数→审批证据链", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/waves/W-2026-09-22/trace/S-OK1-2`);
    assert.equal(res.status, 200);
    const trace = await res.json() as {
      readings: Array<{ firmware: { version: string } | null }>;
      money: { deltaCents: number; adjustmentAdvices?: unknown };
      adjustmentAdvices: Array<{ deltaCents: number }>;
      approvals: Array<{ decision: string }>;
    };
    assert.equal(trace.readings[0].firmware?.version, "fw-2.1.0");
    assert.equal(trace.approvals.length, 2);
    assert.equal(trace.adjustmentAdvices[0].deltaCents, 200);
  });
});

test("未知波次报告返回 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/waves/NOPE/report`);
    assert.equal(res.status, 400);
  });
});

test("比较作业接口幂等：连续调用最终 done=total", async () => {
  await withServer(async (base) => {
    // 演示数据已比较完成；再次触发应保持完成态
    const res = await fetch(`${base}/waves/W-2026-09-22/compare`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as { done: number; total: number; remaining: boolean };
    assert.equal(body.remaining, false);
    assert.equal(body.done, body.total);
  });
});
