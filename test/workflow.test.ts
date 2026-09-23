import assert from "node:assert/strict";
import test from "node:test";
import { CanaryService, ConflictError } from "../src/service.js";
import { newMemoryDb, row, rows } from "./helpers.js";
import { candidateRuleV2, currentRuleV1 } from "../src/rules.js";
import type { Database as DB } from "better-sqlite3";

const T0 = "2026-09-20T00:00:00.000Z";
const W = "W1";
const M = (kwh: number): number => kwh * 1_000_000;

function bootstrap(): { db: DB; svc: CanaryService } {
  const db = newMemoryDb();
  const svc = new CanaryService(db);
  svc.registerRule(currentRuleV1(T0));
  svc.registerRule(candidateRuleV2(T0));
  return { db, svc };
}

function makeWave(svc: CanaryService, waveId = W, thresholds?: Parameters<CanaryService["createWave"]>[0]["thresholds"]): void {
  svc.createWave({
    waveId, scopeSites: ["S1"], scopeModels: ["A1"], scopeBatches: ["B1"],
    currentRuleVersion: "metering-v1", candidateRuleVersion: "metering-v2", thresholds,
  });
}

test("波次只能认领范围内的站点/型号/校准批次", () => {
  const { svc } = bootstrap();
  makeWave(svc);
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, "D1");
  svc.registerDevice({ deviceId: "D2", siteId: "S2", model: "A1", calibrationBatch: "B1" });
  assert.throws(() => svc.claimDevice(W, "D2"), ConflictError);
});

test("两个波次同时认领同一设备被拒绝，唯一归属", () => {
  const { svc } = bootstrap();
  makeWave(svc, "W1");
  makeWave(svc, "W2");
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice("W1", "D1");
  assert.throws(() => svc.claimDevice("W2", "D1"), ConflictError);
});

test("签到重复回报不新建记录；迟到签到允许", () => {
  const { db, svc } = bootstrap();
  makeWave(svc);
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, "D1");
  const a = svc.checkin({ deviceId: "D1", firmwareVersion: "fw-2", firmwareDigest: "h1", installedAt: T0 });
  const b = svc.checkin({ deviceId: "D1", firmwareVersion: "fw-2", firmwareDigest: "h1", installedAt: T0, observedAt: "2026-09-25T00:00:00Z" });
  assert.equal(a.deduplicated, false);
  assert.equal(b.deduplicated, true);
  assert.equal(a.checkinId, b.checkinId);
  assert.equal(rows(db, "SELECT checkin_id FROM device_checkins").length, 1);
});

test("同一会话跨固件版本：表读数原样保留，按片关联当时固件", () => {
  const { db, svc } = bootstrap();
  makeWave(svc);
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, "D1");
  svc.checkin({ deviceId: "D1", firmwareVersion: "fw-1", firmwareDigest: "h1", installedAt: "2026-09-20T00:00:00Z" });
  svc.checkin({ deviceId: "D1", firmwareVersion: "fw-2", firmwareDigest: "h2", installedAt: "2026-09-21T06:30:00Z" });
  svc.ingestSession({ sessionId: "X1", deviceId: "D1", startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T07:00:00Z" });
  svc.ingestSegment({ sessionId: "X1", seq: 1, startReadingMwh: 0, endReadingMwh: M(5), startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T06:30:00Z" });
  svc.ingestSegment({ sessionId: "X1", seq: 2, startReadingMwh: M(5), endReadingMwh: M(9), startedAt: "2026-09-21T06:30:00Z", endedAt: "2026-09-21T07:00:00Z" });
  const fw = rows(db, `SELECT g.seq, c.firmware_version FROM segments g JOIN device_checkins c ON c.checkin_id = g.checkin_id
    WHERE g.session_id = 'X1' ORDER BY g.seq`);
  assert.deepEqual(fw.map((r) => r.firmware_version), ["fw-1", "fw-2"]);
  const readings = rows(db, "SELECT start_reading_mwh, end_reading_mwh FROM segments WHERE session_id='X1' ORDER BY seq");
  assert.deepEqual(readings.map((r) => [r.start_reading_mwh, r.end_reading_mwh]), [[0, M(5)], [M(5), M(9)]]);
});

test("片段重复回报走 upsert，不新建记录", () => {
  const { db, svc } = bootstrap();
  makeWave(svc);
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, "D1");
  svc.ingestSession({ sessionId: "X1", deviceId: "D1", startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T07:00:00Z" });
  const first = svc.ingestSegment({ sessionId: "X1", seq: 1, startReadingMwh: 0, endReadingMwh: M(5), startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T07:00:00Z" });
  const again = svc.ingestSegment({ sessionId: "X1", seq: 1, startReadingMwh: 0, endReadingMwh: M(6), startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T07:00:00Z" });
  assert.equal(first.deduplicated, false);
  assert.equal(again.deduplicated, true);
  assert.equal(rows(db, "SELECT segment_id FROM segments").length, 1);
  assert.equal(row(db, "SELECT end_reading_mwh AS e FROM segments").e, M(6));
});

test("已封账账期不允许被迟到数据改写：重复封账报错且 booked 金额不变", () => {
  const { db, svc } = bootstrap();
  makeWave(svc);
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, "D1");
  svc.ingestSession({ sessionId: "X1", deviceId: "D1", startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T07:00:00Z" });
  svc.ingestSegment({ sessionId: "X1", seq: 1, startReadingMwh: 0, endReadingMwh: M(5), startedAt: "2026-09-21T06:00:00Z", endedAt: "2026-09-21T07:00:00Z" });
  svc.sealPeriod("2026-09-21");
  assert.equal(row(db, "SELECT amount_cents AS a FROM session_settlements").a, 500);
  // 迟到补一片
  svc.ingestSegment({ sessionId: "X1", seq: 2, startReadingMwh: M(5), endReadingMwh: M(8), startedAt: "2026-09-21T07:00:00Z", endedAt: "2026-09-21T07:30:00Z" });
  assert.throws(() => svc.sealPeriod("2026-09-21"), ConflictError);
  assert.equal(row(db, "SELECT amount_cents AS a FROM session_settlements").a, 500);
  assert.equal(row(db, "SELECT arrived_after_seal AS f FROM segments WHERE seq=2").f, 1);
});

test("晋级须计量+清算双签；未双签拒绝", () => {
  const { db, svc } = bootstrap();
  makeWave(svc);
  svc.registerDevice({ deviceId: "D1", siteId: "S1", model: "A1", calibrationBatch: "B1" });
  svc.claimDevice(W, "D1");
  // 没有比较/裁决不能晋级
  assert.throws(() => svc.promote(W), ConflictError);
  assert.equal(row(db, "SELECT status AS s FROM release_waves").s, "running");
});

test("回滚保留已按候选规则入账的结算行与规则版本", () => {
  // 该场景在 lifecycle 测试中完整验证；这里仅校验 rollback 对未晋级波次抛错
  const { svc } = bootstrap();
  makeWave(svc);
  assert.throws(() => svc.rollback(W, "误操作"), ConflictError);
});
