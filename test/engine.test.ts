import assert from "node:assert/strict";
import test from "node:test";
import { compareRules } from "../src/engine.js";
import { candidateRuleV2, currentRuleV1 } from "../src/rules.js";
import type { EngineSegment } from "../src/engine.js";

const NOW = "2026-09-20T00:00:00.000Z";
const V1 = currentRuleV1(NOW);
const V2 = candidateRuleV2(NOW);
const OFFSET = 480; // UTC+8

function seg(seq: number, s: number, e: number, t0: string, t1: string, reset = false): EngineSegment {
  return { seq, start_reading_mwh: s, end_reading_mwh: e, started_at: t0, ended_at: t1, reset_after_previous: reset };
}
const M = (kwh: number): number => kwh * 1_000_000;

test("v1 平价且全额归会话起始日；单日平段两规一致", () => {
  const out = compareRules([seg(1, 0, M(10), "2026-09-21T06:00:00Z", "2026-09-21T07:00:00Z")], V1, V2, OFFSET);
  assert.equal(out.current.totalCents, 1000);
  assert.deepEqual(out.current.perPeriod, { "2026-09-21": 1000 });
  assert.equal(out.candidate.totalCents, 1000);
  assert.equal(out.deltaCents, 0);
});

test("跨零点会话：v1 全归起始日，v2 切段并按谷段计价", () => {
  // 本地 23:00-01:00 共 10kWh
  const out = compareRules([seg(1, 0, M(10), "2026-09-21T15:00:00Z", "2026-09-21T17:00:00Z")], V1, V2, OFFSET);
  assert.deepEqual(out.current.perPeriod, { "2026-09-21": 1000 });
  // v2：23 点 5kWh*1.00 + 00 点 5kWh*0.30
  assert.equal(out.candidate.perPeriod["2026-09-21"], 500);
  assert.equal(out.candidate.perPeriod["2026-09-22"], 150);
  // 跨零点分量只迁移归属、净额为 0
  assert.equal(out.components.midnightTransfer["2026-09-21"], -500);
  assert.equal(out.components.midnightTransfer["2026-09-22"], 500);
  // 谷段价差 -350 全部落在 22 日
  assert.equal(out.components.price["2026-09-22"], -350);
  assert.equal(out.deltaCents, -350);
});

test("声明复位：v1 丢弃复位片，v2 保留；复位分量=找回能量*平价", () => {
  const out = compareRules([
    seg(1, 0, M(20), "2026-09-21T06:00:00Z", "2026-09-21T07:00:00Z"),
    seg(2, 0, M(19), "2026-09-21T07:00:00Z", "2026-09-21T08:00:00Z", true),
  ], V1, V2, OFFSET);
  assert.equal(out.current.totalCents, 2000);
  assert.equal(out.candidate.totalCents, 3900);
  assert.equal(out.components.reset["2026-09-21"], 1900);
  assert.equal(out.deltaCents, 1900);
  assert.equal(out.current.resetCount, 1);
});

test("未声明的读数回退：两规都丢弃该片", () => {
  const out = compareRules([
    seg(1, 0, M(10), "2026-09-21T06:00:00Z", "2026-09-21T06:30:00Z"),
    seg(2, M(9), M(9.5), "2026-09-21T06:30:00Z", "2026-09-21T07:00:00Z"),
  ], V1, V2, OFFSET);
  assert.equal(out.current.totalCents, 1000);
  assert.equal(out.candidate.totalCents, 1000);
  assert.deepEqual(out.candidate.droppedSlices.map((d) => d.reason), ["undeclared_regression"]);
});

test("片内负增量：两规丢弃并累计硬件异常信号", () => {
  const out = compareRules([seg(1, M(10), M(9), "2026-09-21T06:00:00Z", "2026-09-21T07:00:00Z")], V1, V2, OFFSET);
  assert.equal(out.current.totalCents, 0);
  assert.equal(out.candidate.totalCents, 0);
  assert.equal(out.current.negativeCount, 1);
  assert.deepEqual(out.current.droppedSlices.map((d) => d.reason), ["slice_negative"]);
});

test("峰段 TOU：10kWh 本地 10:00 → v2 ¥15.00", () => {
  const out = compareRules([seg(1, 0, M(10), "2026-09-21T02:00:00Z", "2026-09-21T03:00:00Z")], V1, V2, OFFSET);
  assert.equal(out.current.totalCents, 1000);
  assert.equal(out.candidate.totalCents, 1500);
  assert.equal(out.components.price["2026-09-21"], 500);
});

test("缺片率 = 缺失 seq / 应有 seq", () => {
  const out = compareRules([
    seg(1, 0, M(3), "2026-09-21T06:00:00Z", "2026-09-21T06:20:00Z"),
    seg(2, M(3), M(6), "2026-09-21T06:20:00Z", "2026-09-21T06:40:00Z"),
    seg(4, M(9), M(12), "2026-09-21T07:20:00Z", "2026-09-21T07:40:00Z"),
  ], V1, V2, OFFSET);
  assert.equal(out.missingRate, 0.25);
});

test("分量恒等：任意组合 Δ = 跨零点 + 复位 + 价差", () => {
  const out = compareRules([
    seg(1, M(9_960), M(9_980), "2026-09-21T15:00:00Z", "2026-09-21T16:00:00Z"),
    seg(2, 0, M(19), "2026-09-21T16:00:00Z", "2026-09-21T17:00:00Z", true),
  ], V1, V2, OFFSET);
  const sum =
    Object.values(out.components.midnightTransfer).reduce((a, b) => a + b, 0)
    + Object.values(out.components.reset).reduce((a, b) => a + b, 0)
    + Object.values(out.components.price).reduce((a, b) => a + b, 0);
  assert.equal(sum, out.deltaCents);
  assert.equal(Object.values(out.components.midnightTransfer).reduce((a, b) => a + b, 0), 0);
});

test("input_hash 对片段顺序不敏感、对规则版本敏感", () => {
  const a = compareRules([
    seg(1, 0, M(3), "2026-09-21T06:00:00Z", "2026-09-21T06:20:00Z"),
    seg(2, M(3), M(6), "2026-09-21T06:20:00Z", "2026-09-21T06:40:00Z"),
  ], V1, V2, OFFSET);
  const b = compareRules([
    seg(2, M(3), M(6), "2026-09-21T06:20:00Z", "2026-09-21T06:40:00Z"),
    seg(1, 0, M(3), "2026-09-21T06:00:00Z", "2026-09-21T06:20:00Z"),
  ], V1, V2, OFFSET);
  assert.equal(a.inputHash, b.inputHash);
  const other = candidateRuleV2("2026-09-19T00:00:00Z");
  const bumped = { ...other, rule_version: "metering-v9" };
  const c = compareRules([seg(1, 0, M(3), "2026-09-21T06:00:00Z", "2026-09-21T06:20:00Z")], V1, bumped, OFFSET);
  assert.notEqual(c.inputHash, a.inputHash);
});
