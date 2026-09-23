import assert from "node:assert/strict";
import test from "node:test";
import { calculate, type FragmentInput, type RulePayload } from "../src/metering.js";

const baseRule: RulePayload = {
  priceCentsPerKwh: 100,
  roundingMode: "round",
  resetPolicy: "passthrough",
  resetToleranceKwh: 50,
};

function frag(partial: Partial<FragmentInput> & Pick<FragmentInput, "seq" | "readingStart" | "readingEnd" | "startedAt" | "endedAt">): FragmentInput {
  return { firmwareId: "fw", isCandidate: true, isLate: false, ...partial };
}

test("现行规则透传负增量：异常复位造成的偏差直接计入金额", () => {
  const fragments = [
    frag({ seq: 1, startedAt: "2026-09-21T10:00:00Z", endedAt: "2026-09-21T11:00:00Z", readingStart: 100, readingEnd: 120 }),
    frag({ seq: 2, startedAt: "2026-09-21T11:00:00Z", endedAt: "2026-09-21T12:00:00Z", readingStart: 120, readingEnd: 15 }),
  ];
  const r = calculate(fragments, baseRule);
  assert.equal(r.energyKwh, -85); // +20 与 -105 原样相加
  assert.equal(r.amountCents, -8500);
  assert.equal(r.negativeIncrements, 1);
  assert.equal(r.resetEvents, 1);
});

test("候选规则 clamp_zero：负增量归零但仍计数，金额不再被复位污染", () => {
  const rule: RulePayload = { ...baseRule, resetPolicy: "clamp_zero" };
  const fragments = [
    frag({ seq: 1, startedAt: "2026-09-21T10:00:00Z", endedAt: "2026-09-21T11:00:00Z", readingStart: 100, readingEnd: 120 }),
    frag({ seq: 2, startedAt: "2026-09-21T11:00:00Z", endedAt: "2026-09-21T12:00:00Z", readingStart: 120, readingEnd: 15 }),
  ];
  const r = calculate(fragments, rule);
  assert.equal(r.energyKwh, 20);
  assert.equal(r.amountCents, 2000);
  assert.equal(r.negativeIncrements, 1);
  assert.equal(r.resetEvents, 1);
  assert.equal(r.details[1].classified, "reset_clamped");
});

test("wrap 规则：满量程绕回按 rolloverKwh 继续累计", () => {
  const rule: RulePayload = { ...baseRule, resetPolicy: "wrap", rolloverKwh: 1000 };
  const fragments = [
    frag({ seq: 1, startedAt: "2026-09-21T10:00:00Z", endedAt: "2026-09-21T11:00:00Z", readingStart: 990, readingEnd: 20 }),
  ];
  const r = calculate(fragments, rule);
  assert.equal(r.energyKwh, 30); // 20 + 1000 - 990
  assert.equal(r.resetEvents, 1);
  assert.equal(r.details[0].classified, "reset_wrap");
});

test("跨零点片段按时间比例分摊到两个账期，金额逐账期舍入", () => {
  // 22:00 → 次日 02:00，共 4 小时、40kWh，每日各 20kWh。
  const fragments = [
    frag({ seq: 1, startedAt: "2026-09-20T22:00:00Z", endedAt: "2026-09-21T02:00:00Z", readingStart: 0, readingEnd: 40 }),
  ];
  const r = calculate(fragments, baseRule);
  assert.deepEqual(Object.keys(r.periodAmounts).sort(), ["2026-09-20", "2026-09-21"]);
  assert.equal(r.periodAmounts["2026-09-20"], 2000);
  assert.equal(r.periodAmounts["2026-09-21"], 2000);
  assert.equal(r.amountCents, 4000);
});

test("缺片：序号有空洞时缺失数 = 最大序号 - 实收数", () => {
  const fragments = [
    frag({ seq: 1, startedAt: "2026-09-21T10:00:00Z", endedAt: "2026-09-21T10:30:00Z", readingStart: 0, readingEnd: 10 }),
    frag({ seq: 3, startedAt: "2026-09-21T11:00:00Z", endedAt: "2026-09-21T11:30:00Z", readingStart: 20, readingEnd: 30 }),
  ];
  const r = calculate(fragments, baseRule);
  assert.equal(r.expectedFragments, 3);
  assert.equal(r.missingFragments, 1);
});

test("同一批片段喂给新旧规则：除复位解释外读数完全一致，差异只来自规则", () => {
  const fragments = [
    frag({ seq: 1, startedAt: "2026-09-21T10:00:00Z", endedAt: "2026-09-21T11:00:00Z", readingStart: 0, readingEnd: 12 }),
  ];
  const a = calculate(fragments, baseRule);
  const b = calculate(fragments, { ...baseRule, resetPolicy: "clamp_zero" });
  assert.equal(a.amountCents, b.amountCents);
  assert.equal(a.amountCents, 1200);
});
