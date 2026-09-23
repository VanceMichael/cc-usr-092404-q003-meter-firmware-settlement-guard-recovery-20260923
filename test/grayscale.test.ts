import assert from "node:assert/strict";
import test from "node:test";
import { GrayscaleService, GuardrailError } from "../src/grayscale.js";
import { buildWaveReport, renderWaveMarkdown, traceDifference } from "../src/report.js";
import { CANDIDATE, DAY1, DAY2, INCUMBENT, fragment, makeService, seedWorld } from "./helpers.js";

function f(
  id: string,
  seq: number,
  start: number,
  end: number,
  opts: { day?: string; session?: string; firmwareId?: string; hour?: number } = {}
) {
  const day = opts.day ?? DAY1;
  const h = opts.hour ?? 10;
  return fragment({
    fragmentId: id,
    idempotencyKey: `key-${id}`,
    seq,
    clientSessionId: opts.session ?? "sess-1",
    startedAt: `${day}T${String(h).padStart(2, "0")}:00:00Z`,
    endedAt: `${day}T${String(h).padStart(2, "0")}:30:00Z`,
    readingStart: start,
    readingEnd: end,
    firmwareId: opts.firmwareId,
  });
}

test("冻结规则不可修改；重复注册相同内容幂等", () => {
  const { svc } = makeService();
  svc.registerRule(INCUMBENT);
  svc.registerRule(INCUMBENT); // 相同 payload：无操作
  assert.throws(
    () => svc.registerRule({ ...INCUMBENT, payload: { ...INCUMBENT.payload, priceCentsPerKwh: 999 } }),
    GuardrailError
  );
});

test("波次范围限定：站点/型号/校准批次之外的设备不能认领", () => {
  const { svc } = makeService();
  seedWorld(svc);
  assert.throws(() => svc.claimDevice("W1", "D-OUT"), (err: unknown) => err instanceof GuardrailError && err.code === "OUT_OF_WAVE_SCOPE");
});

test("两个波次同时认领设备只有唯一归属，重复认领不新建记录", () => {
  const { svc } = makeService();
  seedWorld(svc);
  svc.registerDevice({ deviceId: "D-NEW", siteId: "S1", model: "M1", calibrationBatch: "B1" });
  assert.equal(svc.claimDevice("W1", "D-NEW"), "claimed");
  assert.equal(svc.claimDevice("W1", "D-NEW"), "already_claimed");
  assert.throws(
    () => svc.claimDevice("W2", "D-NEW"),
    (err: unknown) => err instanceof GuardrailError && err.code === "DEVICE_CLAIMED_BY_OTHER_WAVE"
  );
});

test("签到携带固件摘要/安装时刻/回滚缘由；重复回报不新建记录；回滚缘由留痕", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  const a = svc.checkin({
    deviceId: "D-GOOD",
    firmwareId: "fw-new",
    idempotencyKey: "ci-1",
    installedAt: `${DAY1}T08:00:00Z`,
    reportedAt: `${DAY1}T08:05:00Z`,
  });
  assert.equal(a.isCandidate, true);
  const dup = svc.checkin({
    deviceId: "D-GOOD",
    firmwareId: "fw-new",
    idempotencyKey: "ci-1",
    installedAt: `${DAY1}T08:00:00Z`,
    reportedAt: `${DAY1}T08:05:00Z`,
  });
  assert.equal(dup.duplicate, true);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM device_checkins WHERE device_id='D-GOOD'").get() as { n: number }).n;
  assert.equal(n, 1);

  // 回滚到旧固件，带缘由
  svc.checkin({
    deviceId: "D-GOOD",
    firmwareId: "fw-old",
    idempotencyKey: "ci-2",
    installedAt: `${DAY1}T12:00:00Z`,
    rollbackReason: "计量偏差超阈",
    reportedAt: `${DAY1}T12:10:00Z`,
  });
  const claim = db.prepare("SELECT release_reason FROM wave_devices WHERE wave_id='W1' AND device_id='D-GOOD'").get() as {
    release_reason: string;
  };
  assert.match(claim.release_reason, /计量偏差超阈/);
  // 设备仍归 W1，且只有一行认领历史
  const claims = (db.prepare("SELECT COUNT(*) AS n FROM wave_devices WHERE device_id='D-GOOD'").get() as { n: number }).n;
  assert.equal(claims, 1);
});

test("跨固件版本的同一会话保留表读数并形成固件时间线", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  svc.reportFragments("D-GOOD", [
    f("g1", 1, 0, 10, { firmwareId: "fw-old", hour: 9 }),
    f("g2", 2, 10, 25, { firmwareId: "fw-new", hour: 10 }),
  ]);
  const session = db
    .prepare("SELECT * FROM charging_sessions WHERE device_id='D-GOOD' AND client_session_id='sess-1'")
    .get() as { start_reading: number; end_reading: number; firmware_timeline_json: string };
  assert.equal(session.start_reading, 0); // 未因固件切换清零
  assert.equal(session.end_reading, 25);
  const timeline = JSON.parse(session.firmware_timeline_json) as { firmwareId: string }[];
  assert.deepEqual(
    timeline.map((t) => t.firmwareId),
    ["fw-old", "fw-new"]
  );
});

test("比较裁决：正常设备晋级、复位设备隔离、缺片设备隔离、样本不足待定", () => {
  const { db, svc } = makeService();
  seedWorld(svc);

  // D-GOOD：两个会话，全部正增量，新旧规则同价
  svc.reportFragments("D-GOOD", [
    f("good-1", 1, 0, 12, { session: "s1", hour: 9 }),
    f("good-2", 1, 0, 8, { session: "s2", hour: 14 }),
  ]);

  // D-BAD：两个会话都含片段内大幅回落（120→10）的异常复位；透传与归零价差巨大
  svc.reportFragments("D-BAD", [
    f("bad-1a", 1, 0, 20, { session: "b1", hour: 9 }),
    f("bad-1b", 2, 120, 10, { session: "b1", hour: 10 }),
    f("bad-2a", 1, 0, 20, { session: "b2", hour: 13 }),
    f("bad-2b", 2, 120, 10, { session: "b2", hour: 14 }),
  ]);

  // D-MISS：两个会话各缺 seq 2（缺片率 50%）
  svc.reportFragments("D-MISS", [
    f("miss-1", 1, 0, 10, { session: "m1", hour: 9 }),
    f("miss-1b", 3, 20, 30, { session: "m1", hour: 11 }),
    f("miss-2", 1, 0, 10, { session: "m2", hour: 14 }),
    f("miss-2b", 3, 20, 30, { session: "m2", hour: 16 }),
  ]);

  // D-LOW：只有一个会话
  svc.reportFragments("D-LOW", [f("low-1", 1, 0, 5, { session: "l1", hour: 9 })]);

  const result = svc.runComparison("W1");
  assert.equal(result.interrupted, false);

  const metrics = db
    .prepare("SELECT device_id, decision FROM wave_device_metrics WHERE wave_id='W1'")
    .all() as { device_id: string; decision: string }[];
  const byId = Object.fromEntries(metrics.map((m) => [m.device_id, m.decision]));
  assert.equal(byId["D-GOOD"], "promote");
  assert.equal(byId["D-BAD"], "isolate");
  assert.equal(byId["D-MISS"], "isolate");
  assert.equal(byId["D-LOW"], "pending_sample");

  // 超限设备已隔离
  const bad = db.prepare("SELECT state, isolated_reason FROM devices WHERE device_id='D-BAD'").get() as {
    state: string;
    isolated_reason: string;
  };
  assert.equal(bad.state, "isolated");
  assert.ok(bad.isolated_reason.length > 0);

  // 守恒
  const summary = db.prepare("SELECT * FROM wave_summaries WHERE wave_id='W1'").get() as {
    conservation_ok: number;
    devices_promote: number;
    devices_isolate: number;
    devices_pending: number;
  };
  assert.equal(summary.conservation_ok, 1);
  assert.equal(summary.devices_promote, 1);
  assert.equal(summary.devices_isolate, 2);
  assert.equal(summary.devices_pending, 1);
});

test("双签：单一负责人确认不晋级；计量与清算都确认后新规则只对后续会话生效", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  svc.reportFragments("D-GOOD", [
    f("good-1", 1, 0, 12, { session: "s1", hour: 9 }),
    f("good-2", 1, 0, 8, { session: "s2", hour: 14 }),
  ]);
  svc.runComparison("W1");

  assert.deepEqual(svc.approve("W1", "metering", "张计量", "approve"), { promoted: false });
  const waveBefore = db.prepare("SELECT state FROM release_waves WHERE wave_id='W1'").get() as { state: string };
  assert.equal(waveBefore.state, "active");

  const out = svc.approve("W1", "clearing", "李清算", "approve");
  assert.equal(out.promoted, true);
  const binding = db
    .prepare("SELECT rule_id, firmware_id, state FROM rule_bindings WHERE wave_id='W1' AND device_id='D-GOOD'")
    .get() as { rule_id: string; firmware_id: string; state: string };
  assert.equal(binding.rule_id, CANDIDATE.ruleId);
  assert.equal(binding.state, "effective");

  // D-BAD 等没有数据的设备自然无绑定；隔离设备永远不会出现绑定。
  assert.equal(svc.effectiveRuleForDevice("D-GOOD"), CANDIDATE.ruleId);
  assert.equal(svc.effectiveRuleForDevice("D-BAD"), null);
});

test("未完成比较不允许审批", () => {
  const { svc } = makeService();
  seedWorld(svc);
  assert.throws(
    () => svc.approve("W1", "metering", "张计量", "approve"),
    (err: unknown) => err instanceof GuardrailError && err.code === "NO_COMPARISON_YET"
  );
});

test("回滚撤销绑定但保留波次、规则与全部计算痕迹", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  svc.reportFragments("D-GOOD", [
    f("good-1", 1, 0, 12, { session: "s1", hour: 9 }),
    f("good-2", 1, 0, 8, { session: "s2", hour: 14 }),
  ]);
  svc.runComparison("W1");
  svc.approve("W1", "metering", "张计量", "approve");
  svc.approve("W1", "clearing", "李清算", "approve");

  svc.rollback("W1", "夜盘发现偏差");
  const binding = db.prepare("SELECT state, revoke_reason FROM rule_bindings WHERE wave_id='W1'").get() as {
    state: string;
    revoke_reason: string;
  };
  assert.equal(binding.state, "revoked");
  assert.match(binding.revoke_reason, /夜盘发现偏差/);
  const wave = db.prepare("SELECT state FROM release_waves WHERE wave_id='W1'").get() as { state: string };
  assert.equal(wave.state, "rolled_back");
  assert.equal(svc.effectiveRuleForDevice("D-GOOD"), null);
  // 计算痕迹仍在
  const n = (db.prepare("SELECT COUNT(*) AS n FROM session_calculations WHERE wave_id='W1'").get() as { n: number }).n;
  assert.ok(n >= 2);
});

test("比较作业中断后从已完成会话续算，结果与一次跑完一致", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  svc.reportFragments("D-GOOD", [
    f("good-1", 1, 0, 12, { session: "s1", hour: 9 }),
    f("good-2", 1, 0, 8, { session: "s2", hour: 14 }),
    f("good-3", 1, 0, 6, { session: "s3", hour: 16 }),
  ]);
  const first = svc.runComparison("W1", { crashAfter: 2 });
  assert.equal(first.interrupted, true);
  assert.equal(first.processed, 2);
  const runState = db.prepare("SELECT state FROM comparison_runs WHERE run_id=?").get(first.runId) as {
    state: string;
  };
  assert.equal(runState.state, "interrupted");

  const second = svc.runComparison("W1");
  assert.equal(second.resumed, true);
  assert.equal(second.runId, first.runId);
  assert.equal(second.processed, 1);
  assert.equal(second.skipped, 2);
  const done = (db
    .prepare("SELECT COUNT(*) AS n FROM wave_session_comparisons WHERE wave_id='W1'")
    .get() as { n: number }).n;
  assert.equal(done, 3);
  // 再跑一次：无新数据，全部跳过
  const third = svc.runComparison("W1");
  assert.equal(third.processed, 0);
  assert.equal(third.skipped, 3);
});

test("封账后迟到片段照收并标记，但封账快照不变，只形成调整建议", () => {
  const { db, svc } = makeService();
  seedWorld(svc);

  // 账期 DAY1：先到一个正增量片段（旧固件），随后封账
  svc.reportFragments("D-BAD", [f("late-1", 1, 0, 20, { session: "x1", firmwareId: "fw-old", hour: 9 })]);
  svc.closePeriod(DAY1);
  const booked = db.prepare("SELECT amount_cents FROM session_bookings").get() as { amount_cents: number };
  assert.equal(booked.amount_cents, 2000);
  const closedAt = (db.prepare("SELECT closed_at FROM accounting_periods WHERE period_id=?").get(DAY1) as {
    closed_at: string;
  }).closed_at;

  // 迟到的正增量片段（新固件，采集时间在 DAY1 内，封账后才补传）
  svc.reportFragments("D-BAD", [f("late-2", 2, 5, 10, { session: "x1", firmwareId: "fw-new", hour: 10 })]);
  const frag = db.prepare("SELECT is_late FROM meter_fragments WHERE fragment_id='late-2'").get() as {
    is_late: number;
  };
  assert.equal(frag.is_late, 1);

  // 封账快照不变
  const bookedAfter = db.prepare("SELECT amount_cents FROM session_bookings").get() as { amount_cents: number };
  assert.equal(bookedAfter.amount_cents, 2000);
  const stillClosed = db.prepare("SELECT state FROM accounting_periods WHERE period_id=?").get(DAY1) as {
    state: string;
  };
  assert.equal(stillClosed.state, "closed");
  void closedAt;

  svc.runComparison("W1");
  const proposal = db
    .prepare("SELECT booked_cents, proposed_cents, delta_cents, reason FROM adjustment_proposals WHERE period_id=?")
    .get(DAY1) as { booked_cents: number; proposed_cents: number; delta_cents: number; reason: string };
  // 已封账 2000 分；迟到 +5kWh 使候选口径应为 2500 分，差额 +500 仅以建议形式存在。
  assert.equal(proposal.booked_cents, 2000);
  assert.equal(proposal.proposed_cents, 2500);
  assert.equal(proposal.delta_cents, 500);
  assert.match(proposal.reason, /late_fragment/);
});

test("跨零点会话迟到只改未封账账期的重算，已封账账期仅出建议且守恒成立", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  // 片段 22:00 → 次日 02:00，跨 DAY1/DAY2，40kWh
  svc.reportFragments("D-GOOD", [
    fragment({
      fragmentId: "mid-1",
      idempotencyKey: "key-mid-1",
      seq: 1,
      clientSessionId: "cross-1",
      startedAt: `${DAY1}T22:00:00Z`,
      endedAt: `${DAY2}T02:00:00Z`,
      readingStart: 0,
      readingEnd: 40,
      firmwareId: "fw-new",
    }),
  ]);
  svc.closePeriod(DAY1);
  // DAY1 快照按时间分摊 20kWh
  const b1 = db
    .prepare("SELECT amount_cents FROM session_bookings WHERE period_id=?")
    .get(DAY1) as { amount_cents: number };
  assert.equal(b1.amount_cents, 2000);

  // DAY1 封账后再补一个 DAY1 区间的迟到片（新固件口径，22:30-23:00 额外 +10kWh）
  svc.reportFragments("D-GOOD", [
    fragment({
      fragmentId: "mid-2",
      idempotencyKey: "key-mid-2",
      seq: 2,
      clientSessionId: "cross-1",
      startedAt: `${DAY1}T22:30:00Z`,
      endedAt: `${DAY1}T23:00:00Z`,
      readingStart: 40,
      readingEnd: 50,
      firmwareId: "fw-new",
    }),
  ]);
  svc.closePeriod(DAY2);
  svc.runComparison("W1");

  // DAY1 快照仍然是 2000
  const b1after = db
    .prepare("SELECT amount_cents FROM session_bookings WHERE period_id=?")
    .get(DAY1) as { amount_cents: number };
  assert.equal(b1after.amount_cents, 2000);
  // 出现针对 DAY1 的调整建议
  const p = db
    .prepare("SELECT delta_cents FROM adjustment_proposals WHERE period_id=?")
    .get(DAY1) as { delta_cents: number } | undefined;
  assert.ok(p && p.delta_cents !== 0);

  const summary = db.prepare("SELECT conservation_ok FROM wave_summaries WHERE wave_id='W1'").get() as {
    conservation_ok: number;
  };
  assert.equal(summary.conservation_ok, 1);
});

test("幂等片段上报：重复键不新建记录、不重复计费", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  const r1 = svc.reportFragments("D-GOOD", [f("idem-1", 1, 0, 10, { hour: 9 })]);
  assert.equal(r1.accepted, 1);
  const r2 = svc.reportFragments("D-GOOD", [f("idem-1", 1, 0, 10, { hour: 9 })]);
  assert.equal(r2.accepted, 0);
  assert.equal(r2.duplicate, 1);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM meter_fragments").get() as { n: number }).n;
  assert.equal(n, 1);
});

test("晋级后只有后续会话按候选规则记账；晋级前会话与回滚后会话仍按现行规则", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  // 独立波次 W3：阈值宽松（允许复位价差），样本量 1，便于验证“后续会话生效”。
  svc.registerDevice({ deviceId: "D-N", siteId: "S1", model: "M1", calibrationBatch: "B1" });
  svc.createWave({
    waveId: "W3",
    name: "记账生效波次",
    siteIds: ["S1"],
    deviceModels: ["M1"],
    calibrationBatches: ["B1"],
    incumbentRuleId: INCUMBENT.ruleId,
    candidateRuleId: CANDIDATE.ruleId,
    candidateFirmwareId: "fw-new",
    thresholds: { maxNegativeRate: 1, maxMissingRate: 1, minSessions: 1, maxAmountDiffRel: 10 },
  });
  svc.claimDevice("W3", "D-N");

  // 晋级前会话：片段内含异常复位（片内 120→15），按现行透传记账
  svc.reportFragments("D-N", [
    f("pre-a", 1, 0, 20, { session: "pre", firmwareId: "fw-old", hour: 9 }),
    f("pre-b", 2, 120, 15, { session: "pre", firmwareId: "fw-old", hour: 10 }),
  ]);
  svc.closePeriod(DAY1);
  const preBooking = db
    .prepare(
      `SELECT b.amount_cents, b.booked_rule_id FROM session_bookings b
       JOIN charging_sessions c ON c.session_id=b.session_id
       WHERE c.client_session_id='pre'`
    )
    .get() as { amount_cents: number; booked_rule_id: string };
  assert.equal(preBooking.booked_rule_id, INCUMBENT.ruleId);
  assert.equal(preBooking.amount_cents, -8500); // +20 -105

  // 双签晋级
  svc.runComparison("W3");
  svc.approve("W3", "metering", "张计量", "approve");
  svc.approve("W3", "clearing", "李清算", "approve");

  // 晋级后“后续会话”：同样的复位片段，应按候选归零规则记账
  svc.reportFragments("D-N", [
    f("post-a", 1, 0, 20, { session: "post", firmwareId: "fw-new", day: DAY2, hour: 9 }),
    f("post-b", 2, 120, 15, { session: "post", firmwareId: "fw-new", day: DAY2, hour: 10 }),
  ]);
  svc.closePeriod(DAY2);
  const postBooking = db
    .prepare(
      `SELECT b.amount_cents, b.booked_rule_id FROM session_bookings b
       JOIN charging_sessions c ON c.session_id=b.session_id
       WHERE c.client_session_id='post'`
    )
    .get() as { amount_cents: number; booked_rule_id: string };
  assert.equal(postBooking.booked_rule_id, CANDIDATE.ruleId);
  assert.equal(postBooking.amount_cents, 2000); // 复位归零

  // 回滚后新会话再回到现行规则
  svc.rollback("W3", "复检异常");
  svc.reportFragments("D-N", [
    f("rb2-a", 1, 0, 20, { session: "rb2", firmwareId: "fw-old", day: "2026-09-22", hour: 9 }),
    f("rb2-b", 2, 120, 15, { session: "rb2", firmwareId: "fw-old", day: "2026-09-22", hour: 10 }),
  ]);
  svc.closePeriod("2026-09-22");
  const rbBooking = db
    .prepare(
      `SELECT b.amount_cents, b.booked_rule_id FROM session_bookings b
       JOIN charging_sessions c ON c.session_id=b.session_id
       WHERE c.client_session_id='rb2'`
    )
    .get() as { amount_cents: number; booked_rule_id: string };
  assert.equal(rbBooking.booked_rule_id, INCUMBENT.ruleId);
  assert.equal(rbBooking.amount_cents, -8500);
});

test("（报告与反查）", () => {
  const { db, svc } = makeService();
  seedWorld(svc);
  // 片段内读数大幅回落（120→15）模拟异常复位：现行透传 vs 候选归零。
  svc.reportFragments("D-BAD", [
    f("rep-1a", 1, 0, 20, { session: "r1", firmwareId: "fw-old", hour: 9 }),
    f("rep-1b", 2, 120, 15, { session: "r1", firmwareId: "fw-new", hour: 10 }),
    f("rep-2a", 1, 0, 20, { session: "r2", firmwareId: "fw-old", hour: 13 }),
    f("rep-2b", 2, 120, 15, { session: "r2", firmwareId: "fw-new", hour: 14 }),
  ]);
  svc.runComparison("W1");
  svc.approve("W1", "metering", "张计量", "approve");

  const report = buildWaveReport(db, "W1");
  assert.equal(report.devices.isolate[0].deviceId, "D-BAD");
  assert.ok(report.risk.byCause.rulePricing.cents !== 0);
  assert.ok(report.risk.byCause.abnormalReset.resetEvents >= 2);
  assert.ok(report.summary?.conservationOk);
  // 守恒分解：规则价差 + 数据缺口 = 总净差
  assert.equal(
    report.summary!.ruleDeltaCentsTotal + report.summary!.dataGapCentsTotal,
    report.summary!.deltaCentsTotal
  );

  const md = renderWaveMarkdown(report);
  assert.match(md, /必须隔离/);
  assert.match(md, /D-BAD/);
  assert.match(md, /守恒校验/);

  const sessionId = (db
    .prepare("SELECT session_id FROM charging_sessions WHERE device_id='D-BAD' AND client_session_id='r1'")
    .get() as { session_id: string }).session_id;
  const trace = traceDifference(db, "W1", sessionId);
  assert.deepEqual(
    trace.firmware.map((x) => x.firmwareId).sort(),
    ["fw-new", "fw-old"]
  );
  assert.ok(trace.firmware.every((x) => x.digest.startsWith("sha256:")));
  assert.equal(trace.rules.length, 2);
  assert.equal(trace.rules[0].role, "incumbent");
  assert.equal(trace.rules[1].role, "candidate");
  assert.equal(trace.readingRange.fragments.length, 2);
  assert.equal(trace.readingRange.minReading, 0);
  assert.equal(trace.readingRange.maxReading, 120);
  assert.ok(trace.readingRange.fragmentsHash.length === 64);
  assert.equal(trace.approvals.length, 1);
  assert.equal(trace.approvals[0].role, "metering");
  assert.ok(trace.riskFlags.includes("abnormal_reset"));
  assert.equal(trace.amounts.ruleDeltaCents + trace.amounts.dataGapCents, trace.amounts.deltaCents);
});
