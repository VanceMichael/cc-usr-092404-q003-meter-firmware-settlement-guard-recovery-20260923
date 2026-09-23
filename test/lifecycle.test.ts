import assert from "node:assert/strict";
import test from "node:test";
import { CanaryService, ConflictError } from "../src/service.js";
import { Adjudication, ComparisonJob, generateLateAdvices } from "../src/jobs.js";
import { Reporting } from "../src/reporting.js";
import { newMemoryDb, row, rows } from "./helpers.js";
import { candidateRuleV2, currentRuleV1 } from "../src/rules.js";
import type { Database as DB } from "better-sqlite3";

const T0 = "2026-09-20T00:00:00.000Z";
const W = "W1";
const D = "2026-09-21";
const M = (kwh: number): number => kwh * 1_000_000;
const ISO = (day: string, h: string) => `${day}T${h}:00.000Z`;

interface Sim { db: DB; svc: CanaryService; setClock: (iso: string) => void }

function simEnv(): Sim {
  const db = newMemoryDb();
  let clock = () => Date.parse(T0);
  const setClock = (iso: string) => { clock = () => Date.parse(iso); };
  const svc = new CanaryService(db, 480, () => clock());
  svc.registerRule(currentRuleV1(T0));
  svc.registerRule(candidateRuleV2(T0));
  svc.createWave({
    waveId: W, scopeSites: ["S1"], scopeModels: ["A1"], scopeBatches: ["B1"],
    currentRuleVersion: "metering-v1", candidateRuleVersion: "metering-v2",
    thresholds: { minSamples: 2, maxAmountDeltaRate: 0.1, maxAmountDeltaCents: 1_000 },
  });
  return { db, svc, setClock };
}

function enroll(sim: Sim, device: string): void {
  const { svc } = sim;
  svc.registerDevice({ deviceId: device, siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, device);
  svc.checkin({ deviceId: device, firmwareVersion: "fw-2.1", firmwareDigest: `dig-${device}`, installedAt: T0 });
}

function flatSession(sim: Sim, device: string, sid: string, kwh: number, day = D): void {
  sim.svc.ingestSession({ sessionId: sid, deviceId: device, startedAt: ISO(day, "06:00"), endedAt: ISO(day, "07:00") });
  sim.svc.ingestSegment({ sessionId: sid, seq: 1, startReadingMwh: 0, endReadingMwh: M(kwh), startedAt: ISO(day, "06:00"), endedAt: ISO(day, "07:00") });
}

function scenario(sim: Sim): void {
  enroll(sim, "D-OK");
  enroll(sim, "D-NEG");
  enroll(sim, "D-GAP");
  enroll(sim, "D-AMT");
  enroll(sim, "D-FEW");

  flatSession(sim, "D-OK", "S-OK-1", 10);
  flatSession(sim, "D-OK", "S-OK-2", 8);

  // 负增量设备
  flatSession(sim, "D-NEG", "S-NEG-1", 6);
  sim.svc.ingestSession({ sessionId: "S-NEG-2", deviceId: "D-NEG", startedAt: ISO(D, "06:00"), endedAt: ISO(D, "07:00") });
  sim.svc.ingestSegment({ sessionId: "S-NEG-2", seq: 1, startReadingMwh: M(10), endReadingMwh: M(9), startedAt: ISO(D, "06:00"), endedAt: ISO(D, "07:00") });

  // 缺片设备（seq 1,2,4 → 缺片率 1/4）
  flatSession(sim, "D-GAP", "S-GAP-1", 6);
  sim.svc.ingestSession({ sessionId: "S-GAP-2", deviceId: "D-GAP", startedAt: ISO(D, "06:00"), endedAt: ISO(D, "07:40") });
  for (const [seq, s, e, t0, t1] of [
    [1, 0, M(3), ISO(D, "06:00"), ISO(D, "06:20")],
    [2, M(3), M(6), ISO(D, "06:20"), ISO(D, "06:40")],
    [4, M(9), M(12), ISO(D, "07:20"), ISO(D, "07:40")],
  ] as const) {
    sim.svc.ingestSegment({ sessionId: "S-GAP-2", seq, startReadingMwh: s, endReadingMwh: e, startedAt: t0, endedAt: t1 });
  }

  // 异常复位设备：v1 丢 seq2（19kWh），v2 保留
  for (const sid of ["S-AMT-1", "S-AMT-2"]) {
    sim.svc.ingestSession({ sessionId: sid, deviceId: "D-AMT", startedAt: ISO(D, "06:00"), endedAt: ISO(D, "08:00") });
    sim.svc.ingestSegment({ sessionId: sid, seq: 1, startReadingMwh: M(9_960), endReadingMwh: M(9_980), startedAt: ISO(D, "06:00"), endedAt: ISO(D, "07:00") });
    sim.svc.ingestSegment({ sessionId: sid, seq: 2, startReadingMwh: 0, endReadingMwh: M(19), startedAt: ISO(D, "07:00"), endedAt: ISO(D, "08:00"), resetAfterPrevious: true });
  }

  flatSession(sim, "D-FEW", "S-FEW-1", 5);
}

test("比较作业可中断续算：分批处理最终 1:1 完成且不重复", () => {
  const sim = simEnv();
  scenario(sim);
  const job = new ComparisonJob(sim.svc, sim.db);
  const first = job.runToCompletion(W, 2);
  assert.equal(first.done, 2);
  assert.equal(first.total, 9);
  assert.equal(first.remaining, true);
  job.runToCompletion(W, 3);
  assert.equal(row(sim.db, "SELECT sessions_done AS d, status AS s FROM comparison_runs").d, 5);
  const last = job.runToCompletion(W);
  assert.equal(last.done, 9);
  assert.equal(last.remaining, false);
  assert.equal(row(sim.db, "SELECT status AS s FROM comparison_runs").s, "done");
  // 每会话仅一条比较结果
  assert.equal(rows(sim.db, "SELECT session_id FROM session_comparisons").length, 9);
});

test("裁决：健康晋级；负增量/缺片/金额超限隔离；样本不足暂缓", () => {
  const sim = simEnv();
  scenario(sim);
  new ComparisonJob(sim.svc, sim.db).runToCompletion(W);
  const verdicts = new Adjudication(sim.svc, sim.db).decide(W);
  const byDevice = Object.fromEntries(verdicts.map((v) => [v.deviceId, v]));
  assert.equal(byDevice["D-OK"].decision, "promote");
  assert.equal(byDevice["D-NEG"].decision, "quarantine");
  assert.match(byDevice["D-NEG"].reasons.join(";"), /负增量/);
  assert.equal(byDevice["D-GAP"].decision, "quarantine");
  assert.match(byDevice["D-GAP"].reasons.join(";"), /缺片率/);
  assert.equal(byDevice["D-AMT"].decision, "quarantine");
  assert.match(byDevice["D-AMT"].reasons.join(";"), /金额差异/);
  assert.equal(byDevice["D-FEW"].decision, "blocked");
  // 隔离设备禁止新会话
  assert.throws(() => flatSession(sim, "D-NEG", "S-NEG-X", 1), ConflictError);
  // 认领状态
  assert.equal(row(sim.db, "SELECT status AS s FROM device_claims WHERE device_id='D-AMT'").s, "isolated");
});

test("未完成比较不能裁决", () => {
  const sim = simEnv();
  scenario(sim);
  new ComparisonJob(sim.svc, sim.db).runToCompletion(W, 2);
  assert.throws(() => new Adjudication(sim.svc, sim.db).decide(W), /尚未跑到完成/);
});

test("双签→晋级→候选规则作用于后续会话→封账→回滚保留候选入账", () => {
  const sim = simEnv();
  scenario(sim);
  new ComparisonJob(sim.svc, sim.db).runToCompletion(W);
  new Adjudication(sim.svc, sim.db).decide(W);

  // 单签不能晋级
  sim.setClock("2026-09-22T01:00:00.000Z");
  sim.svc.approve(W, "metering_lead", "计量", "approved");
  assert.throws(() => sim.svc.promote(W), ConflictError);
  sim.svc.approve(W, "clearing_lead", "清算", "approved");
  sim.svc.promote(W);
  assert.equal(row(sim.db, "SELECT status AS s FROM release_waves").s, "promoted");
  assert.equal(row(sim.db, "SELECT status AS s FROM device_claims WHERE device_id='D-OK'").s, "promoted");

  // 晋级后的峰段会话按 v2 出账（10kWh*1.50 = ¥15.00），v1 只会是 ¥10.00
  sim.svc.ingestSession({ sessionId: "S-POST", deviceId: "D-OK", startedAt: ISO("2026-09-22", "02:00"), endedAt: ISO("2026-09-22", "03:00") });
  sim.svc.ingestSegment({ sessionId: "S-POST", seq: 1, startReadingMwh: 0, endReadingMwh: M(10), startedAt: ISO("2026-09-22", "02:00"), endedAt: ISO("2026-09-22", "03:00") });
  sim.setClock("2026-09-23T00:30:00.000Z");
  sim.svc.sealPeriod("2026-09-22");
  const booked = row(sim.db, "SELECT rule_version AS r, amount_cents AS a, status AS s FROM session_settlements WHERE session_id='S-POST'");
  assert.equal(booked.r, "metering-v2");
  assert.equal(booked.a, 1500);
  assert.equal(booked.s, "booked");

  // 回滚：结算行原样保留，认领释放
  sim.svc.rollback(W, "修订峰谷配置");
  const after = row(sim.db, "SELECT rule_version AS r, amount_cents AS a, status AS s FROM session_settlements WHERE session_id='S-POST'");
  assert.deepEqual(after, booked);
  assert.equal(row(sim.db, "SELECT status AS s FROM device_claims WHERE device_id='D-OK'").s, "released");
  assert.equal(row(sim.db, "SELECT status AS s FROM release_waves").s, "rolled_back");
});

test("封账后迟到数据不改账，只产生调整建议；重复生成不新建多条", () => {
  const sim = simEnv();
  scenario(sim);
  new ComparisonJob(sim.svc, sim.db).runToCompletion(W);
  sim.setClock("2026-09-22T00:30:00.000Z");
  sim.svc.sealPeriod(D);
  const before = row(sim.db, "SELECT amount_cents AS a FROM session_settlements WHERE session_id='S-OK-1'").a;
  // 迟到 +3kWh 平段（v1 归会话起始日）→ 建议 +¥3.00
  sim.svc.ingestSegment({ sessionId: "S-OK-1", seq: 2, startReadingMwh: M(10), endReadingMwh: M(13), startedAt: ISO(D, "07:00"), endedAt: ISO(D, "07:30") });
  assert.equal(generateLateAdvices(sim.svc, sim.db), 1);
  assert.equal(generateLateAdvices(sim.svc, sim.db), 0); // 幂等：不重复新建
  assert.equal(row(sim.db, "SELECT amount_cents AS a FROM session_settlements WHERE session_id='S-OK-1'").a, before);
  const advice = row(sim.db, "SELECT booked_cents AS b, advised_cents AS n, delta_cents AS d FROM adjustment_advices");
  assert.deepEqual({ b: advice.b, n: advice.n, d: advice.d }, { b: 1000, n: 1300, d: 300 });
});

test("波次报告守恒校验全过，且可由一笔差异反查完整证据链", () => {
  const sim = simEnv();
  scenario(sim);
  new ComparisonJob(sim.svc, sim.db).runToCompletion(W);
  new Adjudication(sim.svc, sim.db).decide(W);
  sim.setClock("2026-09-22T01:00:00.000Z");
  sim.svc.approve(W, "metering_lead", "计量", "approved");
  sim.svc.approve(W, "clearing_lead", "清算", "approved");

  const reporting = new Reporting(sim.db);
  const report = reporting.buildWaveReport(W);
  assert.ok(report.checks.every((c) => c.passed), report.checks.filter((c) => !c.passed).map((c) => c.detail).join(";"));
  // 设备级金额合计 = 波次级
  const sumDevice = report.devices.reduce((s, d) => s + ((d.metrics as { currentCents: number }).currentCents), 0);
  assert.equal(sumDevice, report.totals.currentCents);

  const trace = reporting.traceDifference(W, "S-AMT-1");
  assert.equal(trace.wave.currentRuleVersion, "metering-v1");
  assert.equal(trace.wave.candidateRuleVersion, "metering-v2");
  assert.ok(trace.wave.currentRuleDefinition.attribution);
  assert.equal(trace.readings.length, 2);
  assert.equal(trace.readings[1].resetAfterPrevious, true);
  assert.equal(trace.money.components.reset[D], 1900);
  assert.deepEqual(trace.approvals.map((a) => a.role).sort(), ["clearing_lead", "metering_lead"]);
  assert.ok(trace.comparisonRun.runId);
  assert.ok(trace.session.inputHash);
});
