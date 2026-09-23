import type { Database as DB } from "better-sqlite3";
import type { RulePayload, WaveThresholds } from "./grayscale.js";

// 报告与反查：纯读路径，不写任何业务数据。

interface Json {
  [k: string]: unknown;
}

function parse<T>(s: string): T {
  return JSON.parse(s) as T;
}

export interface DeviceReportRow {
  deviceId: string;
  siteId: string;
  model: string;
  calibrationBatch: string;
  state: string;
  sessionCount: number;
  negativeRate: number;
  missingRate: number;
  amountDiffAbsCents: number;
  amountNetCents: number;
  dataGapCents: number;
  ruleDeltaCents: number;
  amountDiffRel: number;
  decision: "promote" | "isolate" | "pending_sample";
  reasons: string[];
}

export interface WaveReport {
  wave: {
    waveId: string;
    name: string;
    scope: { siteIds: string[]; deviceModels: string[]; calibrationBatches: string[] };
    state: string;
    thresholds: WaveThresholds;
  };
  artifacts: {
    candidateFirmware: { firmwareId: string; digest: string; versionLabel: string };
    incumbentRule: { ruleId: string; label: string; payload: RulePayload; frozenAt: string };
    candidateRule: { ruleId: string; label: string; payload: RulePayload; frozenAt: string };
  };
  summary: {
    devicesTotal: number;
    devicesPromote: number;
    devicesIsolate: number;
    devicesPending: number;
    sessionsCompared: number;
    incumbentCentsTotal: number;
    candidateCentsTotal: number;
    bookedCentsTotal: number;
    baselineCentsTotal: number;
    deltaCentsTotal: number;
    ruleDeltaCentsTotal: number;
    dataGapCentsTotal: number;
    conservationOk: boolean;
    sessionsHash: string;
    runId: string;
  } | null;
  devices: {
    promote: DeviceReportRow[];
    isolate: DeviceReportRow[];
    pending: DeviceReportRow[];
  };
  risk: {
    byCause: {
      rulePricing: { sessions: number; cents: number };
      lateOrMissing: { sessions: number; cents: number };
      abnormalReset: { sessions: number; negativeIncrements: number; resetEvents: number };
      negativeIncrement: { sessions: number; count: number };
      crossesMidnight: { sessions: number };
    };
    topSessions: {
      sessionId: string;
      deviceId: string;
      clientSessionId: string;
      bookedCents: number;
      candidateCents: number;
      deltaCents: number;
      ruleDeltaCents: number;
      dataGapCents: number;
      flags: string[];
    }[];
  };
  approvals: { role: string; approver: string; decision: string; approvedAt: string }[];
  adjustments: {
    proposalId: string;
    deviceId: string;
    periodId: string;
    sessionId: string;
    bookedCents: number;
    proposedCents: number;
    deltaCents: number;
    reason: string;
    state: string;
  }[];
  comparedAt: string | null;
}

export function buildWaveReport(db: DB, waveId: string): WaveReport {
  const wave = db.prepare("SELECT * FROM release_waves WHERE wave_id=?").get(waveId) as
    | {
        wave_id: string;
        name: string;
        site_ids_json: string;
        device_models_json: string;
        calibration_batches_json: string;
        state: string;
        thresholds_json: string;
        incumbent_rule_id: string;
        candidate_rule_id: string;
        candidate_firmware_id: string;
      }
    | undefined;
  if (!wave) throw new Error(`波次 ${waveId} 不存在`);

  const fw = db.prepare("SELECT * FROM firmware_versions WHERE firmware_id=?").get(wave.candidate_firmware_id) as {
    firmware_id: string;
    digest: string;
    version_label: string;
  };
  const ruleInc = db.prepare("SELECT * FROM rule_versions WHERE rule_id=?").get(wave.incumbent_rule_id) as {
    rule_id: string;
    label: string;
    payload_json: string;
    frozen_at: string;
  };
  const ruleCand = db.prepare("SELECT * FROM rule_versions WHERE rule_id=?").get(wave.candidate_rule_id) as {
    rule_id: string;
    label: string;
    payload_json: string;
    frozen_at: string;
  };

  const summaryRow = db.prepare("SELECT * FROM wave_summaries WHERE wave_id=?").get(waveId) as
    | {
        run_id: string;
        devices_total: number;
        devices_promote: number;
        devices_isolate: number;
        devices_pending: number;
        sessions_compared: number;
        incumbent_cents_total: number;
        candidate_cents_total: number;
        baseline_cents_total: number;
        delta_cents_total: number;
        conservation_ok: number;
        sessions_hash: string;
      }
    | undefined;

  const bookedTotal = (db
    .prepare("SELECT COALESCE(SUM(booked_cents),0) AS v FROM wave_session_comparisons WHERE wave_id=?")
    .get(waveId) as { v: number }).v;
  const ruleDeltaTotal = (db
    .prepare("SELECT COALESCE(SUM(rule_delta_cents),0) AS v FROM wave_session_comparisons WHERE wave_id=?")
    .get(waveId) as { v: number }).v;
  const dataGapTotal = (db
    .prepare("SELECT COALESCE(SUM(data_gap_cents),0) AS v FROM wave_session_comparisons WHERE wave_id=?")
    .get(waveId) as { v: number }).v;

  const metricRows = db
    .prepare(
      `SELECT m.*, d.site_id, d.model, d.calibration_batch, d.state AS device_state
       FROM wave_device_metrics m JOIN devices d ON d.device_id = m.device_id
       WHERE m.wave_id=? ORDER BY m.decision, m.amount_diff_abs_cents DESC`
    )
    .all(waveId) as {
    device_id: string;
    site_id: string;
    model: string;
    calibration_batch: string;
    device_state: string;
    session_count: number;
    negative_rate: number;
    missing_rate: number;
    amount_diff_abs_cents: number;
    amount_net_cents: number;
    data_gap_cents: number;
    rule_delta_cents: number;
    amount_diff_rel: number;
    decision: DeviceReportRow["decision"];
    reasons_json: string;
  }[];

  const toRow = (r: (typeof metricRows)[number]): DeviceReportRow => ({
    deviceId: r.device_id,
    siteId: r.site_id,
    model: r.model,
    calibrationBatch: r.calibration_batch,
    state: r.device_state,
    sessionCount: r.session_count,
    negativeRate: r.negative_rate,
    missingRate: r.missing_rate,
    amountDiffAbsCents: r.amount_diff_abs_cents,
    amountNetCents: r.amount_net_cents,
    dataGapCents: r.data_gap_cents,
    ruleDeltaCents: r.rule_delta_cents,
    amountDiffRel: r.amount_diff_rel,
    decision: r.decision,
    reasons: parse<string[]>(r.reasons_json),
  });

  const devices = {
    promote: metricRows.filter((r) => r.decision === "promote").map(toRow),
    isolate: metricRows.filter((r) => r.decision === "isolate").map(toRow),
    pending: metricRows.filter((r) => r.decision === "pending_sample").map(toRow),
  };

  // ---- 风险归因 ----
  const flagged = (flag: string) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(delta_cents),0) AS cents
         FROM wave_session_comparisons WHERE wave_id=? AND EXISTS (
           SELECT 1 FROM json_each(risk_flags_json) WHERE value=?)`
      )
      .get(waveId, flag) as { n: number; cents: number };

  const resetAgg = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(sc.reset_events),0) AS resets,
              COALESCE(SUM(sc.negative_increments),0) AS negs
       FROM wave_session_comparisons cmp
       JOIN session_calculations sc ON sc.calculation_id = cmp.candidate_calc_id
       WHERE cmp.wave_id=? AND EXISTS (SELECT 1 FROM json_each(cmp.risk_flags_json) WHERE value='abnormal_reset')`
    )
    .get(waveId) as { n: number; resets: number; negs: number };

  const negAgg = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(sc.negative_increments),0) AS cnt
       FROM wave_session_comparisons cmp
       JOIN session_calculations sc ON sc.calculation_id = cmp.candidate_calc_id
       WHERE cmp.wave_id=? AND sc.negative_increments > 0`
    )
    .get(waveId) as { n: number; cnt: number };

  const topSessions = db
    .prepare(
      `SELECT cmp.session_id, cmp.device_id, c.client_session_id, cmp.booked_cents,
              cmp.candidate_cents, cmp.delta_cents, cmp.rule_delta_cents, cmp.data_gap_cents,
              cmp.risk_flags_json
       FROM wave_session_comparisons cmp
       JOIN charging_sessions c ON c.session_id = cmp.session_id
       WHERE cmp.wave_id=?
       ORDER BY ABS(cmp.delta_cents) DESC LIMIT 10`
    )
    .all(waveId) as {
    session_id: string;
    device_id: string;
    client_session_id: string;
    booked_cents: number;
    candidate_cents: number;
    delta_cents: number;
    rule_delta_cents: number;
    data_gap_cents: number;
    risk_flags_json: string;
  }[];

  const approvals = db
    .prepare("SELECT role, approver, decision, approved_at FROM wave_approvals WHERE wave_id=? ORDER BY role")
    .all(waveId) as { role: string; approver: string; decision: string; approved_at: string }[];

  const adjustments = db
    .prepare(
      `SELECT proposal_id, device_id, period_id, session_id, booked_cents, proposed_cents,
              delta_cents, reason, state
       FROM adjustment_proposals WHERE wave_id=? ORDER BY period_id, ABS(delta_cents) DESC`
    )
    .all(waveId) as {
    proposal_id: string;
    device_id: string;
    period_id: string;
    session_id: string;
    booked_cents: number;
    proposed_cents: number;
    delta_cents: number;
    reason: string;
    state: string;
  }[];

  return {
    wave: {
      waveId: wave.wave_id,
      name: wave.name,
      scope: {
        siteIds: parse<string[]>(wave.site_ids_json),
        deviceModels: parse<string[]>(wave.device_models_json),
        calibrationBatches: parse<string[]>(wave.calibration_batches_json),
      },
      state: wave.state,
      thresholds: parse<WaveThresholds>(wave.thresholds_json),
    },
    artifacts: {
      candidateFirmware: {
        firmwareId: fw.firmware_id,
        digest: fw.digest,
        versionLabel: fw.version_label,
      },
      incumbentRule: {
        ruleId: ruleInc.rule_id,
        label: ruleInc.label,
        payload: parse<RulePayload>(ruleInc.payload_json),
        frozenAt: ruleInc.frozen_at,
      },
      candidateRule: {
        ruleId: ruleCand.rule_id,
        label: ruleCand.label,
        payload: parse<RulePayload>(ruleCand.payload_json),
        frozenAt: ruleCand.frozen_at,
      },
    },
    summary: summaryRow
      ? {
          devicesTotal: summaryRow.devices_total,
          devicesPromote: summaryRow.devices_promote,
          devicesIsolate: summaryRow.devices_isolate,
          devicesPending: summaryRow.devices_pending,
          sessionsCompared: summaryRow.sessions_compared,
          incumbentCentsTotal: summaryRow.incumbent_cents_total,
          candidateCentsTotal: summaryRow.candidate_cents_total,
          bookedCentsTotal: bookedTotal,
          baselineCentsTotal: summaryRow.baseline_cents_total,
          deltaCentsTotal: summaryRow.delta_cents_total,
          ruleDeltaCentsTotal: ruleDeltaTotal,
          dataGapCentsTotal: dataGapTotal,
          conservationOk: !!summaryRow.conservation_ok,
          sessionsHash: summaryRow.sessions_hash,
          runId: summaryRow.run_id,
        }
      : null,
    devices,
    risk: {
      byCause: {
        rulePricing: { sessions: flagged("rule_amount_delta").n, cents: ruleDeltaTotal },
        lateOrMissing: {
          sessions: (db
            .prepare(
              `SELECT COUNT(*) AS n FROM wave_session_comparisons WHERE wave_id=?
               AND (has_late=1 OR EXISTS (SELECT 1 FROM json_each(risk_flags_json) WHERE value='missing_fragment'))`
            )
            .get(waveId) as { n: number }).n,
          cents: dataGapTotal,
        },
        abnormalReset: {
          sessions: resetAgg.n,
          negativeIncrements: resetAgg.negs,
          resetEvents: resetAgg.resets,
        },
        negativeIncrement: { sessions: negAgg.n, count: negAgg.cnt },
        crossesMidnight: { sessions: flagged("crosses_midnight").n },
      },
      topSessions: topSessions.map((s) => ({
        sessionId: s.session_id,
        deviceId: s.device_id,
        clientSessionId: s.client_session_id,
        bookedCents: s.booked_cents,
        candidateCents: s.candidate_cents,
        deltaCents: s.delta_cents,
        ruleDeltaCents: s.rule_delta_cents,
        dataGapCents: s.data_gap_cents,
        flags: parse<string[]>(s.risk_flags_json),
      })),
    },
    approvals: approvals.map((a) => ({
      role: a.role,
      approver: a.approver,
      decision: a.decision,
      approvedAt: a.approved_at,
    })),
    adjustments: adjustments.map((a) => ({
      proposalId: a.proposal_id,
      deviceId: a.device_id,
      periodId: a.period_id,
      sessionId: a.session_id,
      bookedCents: a.booked_cents,
      proposedCents: a.proposed_cents,
      deltaCents: a.delta_cents,
      reason: a.reason,
      state: a.state,
    })),
    comparedAt:
      (db.prepare("SELECT MAX(compared_at) AS v FROM wave_session_comparisons WHERE wave_id=?").get(waveId) as {
        v: string | null;
      }).v ?? null,
  };
}

// ================= 差异反查 =================

export interface DifferenceTrace {
  waveId: string;
  session: {
    sessionId: string;
    clientSessionId: string;
    deviceId: string;
    periodId: string;
    startedAt: string;
    endedAt: string | null;
    startReading: number;
    endReading: number | null;
    firmwareTimeline: { at: string; firmwareId: string; reading: number }[];
  };
  firmware: { firmwareId: string; digest: string; versionLabel: string }[];
  rules: {
    role: "incumbent" | "candidate";
    ruleId: string;
    label: string;
    payload: RulePayload;
    frozenAt: string;
  }[];
  readingRange: {
    firstSeq: number;
    lastSeq: number;
    minReading: number;
    maxReading: number;
    fragmentsHash: string;
    lateFragments: number;
    fragments: {
      seq: number;
      startedAt: string;
      endedAt: string;
      readingStart: number;
      readingEnd: number;
      firmwareId: string;
      isLate: boolean;
    }[];
  };
  amounts: {
    bookedCents: number;
    baselineCents: number;
    incumbentCents: number;
    candidateCents: number;
    deltaCents: number;
    ruleDeltaCents: number;
    dataGapCents: number;
    periodAmounts: { role: string; periodId: string; cents: number }[];
    bookings: { periodId: string; cents: number; bookedRuleId: string }[];
  };
  approvals: { role: string; approver: string; decision: string; approvedAt: string }[];
  waveState: string;
  decidedAt: string | null;
  riskFlags: string[];
  adjustment: {
    periodId: string;
    bookedCents: number;
    proposedCents: number;
    deltaCents: number;
    reason: string;
    state: string;
  } | null;
}

export function traceDifference(db: DB, waveId: string, sessionId: string): DifferenceTrace {
  const cmp = db
    .prepare("SELECT * FROM wave_session_comparisons WHERE wave_id=? AND session_id=?")
    .get(waveId, sessionId) as
    | {
        incumbent_calc_id: string;
        candidate_calc_id: string;
        booked_cents: number;
        baseline_cents: number;
        incumbent_cents: number;
        candidate_cents: number;
        delta_cents: number;
        rule_delta_cents: number;
        data_gap_cents: number;
        risk_flags_json: string;
        fragments_hash: string;
      }
    | undefined;
  if (!cmp) throw new Error(`波次 ${waveId} 中没有会话 ${sessionId} 的比较结果`);

  const session = db.prepare("SELECT * FROM charging_sessions WHERE session_id=?").get(sessionId) as {
    session_id: string;
    client_session_id: string;
    device_id: string;
    period_id: string;
    started_at: string;
    ended_at: string | null;
    start_reading: number;
    end_reading: number | null;
    firmware_timeline_json: string;
  };
  const wave = db.prepare("SELECT state, decided_at FROM release_waves WHERE wave_id=?").get(waveId) as {
    state: string;
    decided_at: string | null;
  };

  const fragments = db
    .prepare("SELECT * FROM meter_fragments WHERE session_id=? ORDER BY seq")
    .all(sessionId) as {
    seq: number;
    started_at: string;
    ended_at: string;
    reading_start: number;
    reading_end: number;
    firmware_id: string;
    is_late: number;
  }[];

  const firmwareIds = [...new Set(fragments.map((f) => f.firmware_id))];
  const firmware = (
    db
      .prepare(
        `SELECT firmware_id, digest, version_label FROM firmware_versions
         WHERE firmware_id IN (${firmwareIds.map(() => "?").join(",")})`
      )
      .all(...firmwareIds) as { firmware_id: string; digest: string; version_label: string }[]
  ).map((f) => ({ firmwareId: f.firmware_id, digest: f.digest, versionLabel: f.version_label }));

  const calcs = db
    .prepare(
      `SELECT * FROM session_calculations WHERE wave_id=? AND session_id=?
       ORDER BY CASE rule_role WHEN 'incumbent' THEN 0 ELSE 1 END`
    )
    .all(waveId, sessionId) as {
    rule_role: "incumbent" | "candidate";
    rule_id: string;
    period_amounts_json: string;
  }[];
  const rules = calcs.map((c) => {
    const r = db.prepare("SELECT * FROM rule_versions WHERE rule_id=?").get(c.rule_id) as {
      rule_id: string;
      label: string;
      payload_json: string;
      frozen_at: string;
    };
    return {
      role: c.rule_role,
      ruleId: r.rule_id,
      label: r.label,
      payload: parse<RulePayload>(r.payload_json),
      frozenAt: r.frozen_at,
    };
  });

  const readings = fragments.flatMap((f) => [f.reading_start, f.reading_end]);
  const bookings = db
    .prepare("SELECT period_id, amount_cents, booked_rule_id FROM session_bookings WHERE session_id=?")
    .all(sessionId) as { period_id: string; amount_cents: number; booked_rule_id: string }[];
  const approvals = db
    .prepare("SELECT role, approver, decision, approved_at FROM wave_approvals WHERE wave_id=? ORDER BY role")
    .all(waveId) as { role: string; approver: string; decision: string; approved_at: string }[];
  const adjustment = db
    .prepare(
      `SELECT period_id, booked_cents, proposed_cents, delta_cents, reason, state
       FROM adjustment_proposals WHERE wave_id=? AND session_id=? LIMIT 1`
    )
    .get(waveId, sessionId) as
    | { period_id: string; booked_cents: number; proposed_cents: number; delta_cents: number; reason: string; state: string }
    | undefined;

  return {
    waveId,
    session: {
      sessionId: session.session_id,
      clientSessionId: session.client_session_id,
      deviceId: session.device_id,
      periodId: session.period_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      startReading: session.start_reading ?? readings[0],
      endReading: session.end_reading,
      firmwareTimeline: parse(session.firmware_timeline_json),
    },
    firmware,
    rules,
    readingRange: {
      firstSeq: fragments[0]?.seq ?? 0,
      lastSeq: fragments[fragments.length - 1]?.seq ?? 0,
      minReading: readings.length ? Math.min(...readings) : 0,
      maxReading: readings.length ? Math.max(...readings) : 0,
      fragmentsHash: cmp.fragments_hash,
      lateFragments: fragments.filter((f) => f.is_late).length,
      fragments: fragments.map((f) => ({
        seq: f.seq,
        startedAt: f.started_at,
        endedAt: f.ended_at,
        readingStart: f.reading_start,
        readingEnd: f.reading_end,
        firmwareId: f.firmware_id,
        isLate: !!f.is_late,
      })),
    },
    amounts: {
      bookedCents: cmp.booked_cents,
      baselineCents: cmp.baseline_cents,
      incumbentCents: cmp.incumbent_cents,
      candidateCents: cmp.candidate_cents,
      deltaCents: cmp.delta_cents,
      ruleDeltaCents: cmp.rule_delta_cents,
      dataGapCents: cmp.data_gap_cents,
      periodAmounts: calcs.flatMap((c) =>
        Object.entries(parse<Record<string, number>>(c.period_amounts_json)).map(([periodId, cents]) => ({
          role: c.rule_role,
          periodId,
          cents,
        }))
      ),
      bookings: bookings.map((b) => ({ periodId: b.period_id, cents: b.amount_cents, bookedRuleId: b.booked_rule_id })),
    },
    approvals: approvals.map((a) => ({
      role: a.role,
      approver: a.approver,
      decision: a.decision,
      approvedAt: a.approved_at,
    })),
    waveState: wave.state,
    decidedAt: wave.decided_at,
    riskFlags: parse<string[]>(cmp.risk_flags_json),
    adjustment: adjustment
      ? {
          periodId: adjustment.period_id,
          bookedCents: adjustment.booked_cents,
          proposedCents: adjustment.proposed_cents,
          deltaCents: adjustment.delta_cents,
          reason: adjustment.reason,
          state: adjustment.state,
        }
      : null,
  };
}

// ================= Markdown 报告 =================

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

const FLAG_LABELS: Record<string, string> = {
  negative_increment: "负增量",
  abnormal_reset: "异常复位",
  missing_fragment: "缺片",
  late_fragment: "迟到片段",
  crosses_midnight: "跨零点",
  rule_amount_delta: "规则价差",
  mixed_firmware_session: "跨版本会话",
};

export function renderWaveMarkdown(r: WaveReport): string {
  const lines: string[] = [];
  lines.push(`# 固件灰度结算报告 · ${r.wave.name}（${r.wave.waveId}）`);
  lines.push("");
  lines.push(`- 波次状态：**${r.wave.state}**`);
  lines.push(
    `- 灰度范围：站点 [${r.wave.scope.siteIds.join(", ")}]；型号 [${r.wave.scope.deviceModels.join(", ")}]；校准批次 [${r.wave.scope.calibrationBatches.join(", ")}]`
  );
  lines.push(
    `- 候选固件：${r.artifacts.candidateFirmware.versionLabel}（\`${r.artifacts.candidateFirmware.firmwareId}\`，摘要 \`${r.artifacts.candidateFirmware.digest.slice(0, 16)}…\`）`
  );
  lines.push(
    `- 规则：现行 ${r.artifacts.incumbentRule.ruleId}（${r.artifacts.incumbentRule.label}） vs 候选 ${r.artifacts.candidateRule.ruleId}（${r.artifacts.candidateRule.label}）`
  );
  const t = r.wave.thresholds;
  lines.push(
    `- 门槛：负增量率 ≤ ${pct(t.maxNegativeRate)}，缺片率 ≤ ${pct(t.maxMissingRate)}，样本 ≥ ${t.minSessions} 会话，金额相对差 ≤ ${pct(t.maxAmountDiffRel)}`
  );
  lines.push("");

  if (!r.summary) {
    lines.push("> 比较作业尚未完成，暂无裁决与金额汇总。");
    return lines.join("\n");
  }
  const s = r.summary;
  lines.push("## 裁决汇总");
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 可晋级设备 | **${s.devicesPromote}** |`);
  lines.push(`| 必须隔离设备 | **${s.devicesIsolate}** |`);
  lines.push(`| 样本不足设备 | ${s.devicesPending} |`);
  lines.push(`| 已比较会话 | ${s.sessionsCompared} |`);
  lines.push(`| 现行规则金额（全部片段重算） | ${yuan(s.incumbentCentsTotal)} |`);
  lines.push(`| 候选规则金额 | ${yuan(s.candidateCentsTotal)} |`);
  lines.push(`| 现行基线金额（按时片段） | ${yuan(s.baselineCentsTotal)} |`);
  lines.push(`| 其中已封账金额（不可改） | ${yuan(s.bookedCentsTotal)} |`);
  lines.push(`| 候选 − 现行基线（总净差） | **${yuan(s.deltaCentsTotal)}** |`);
  lines.push(`| 守恒校验 | ${s.conservationOk ? "✅ 通过" : "❌ 失败"} |`);
  lines.push(`| 比较运行 | \`${s.runId}\` |`);
  lines.push(`| 会话指纹 | \`${s.sessionsHash.slice(0, 16)}…\` |`);
  lines.push("");

  lines.push("## 金额风险来自哪里");
  lines.push("");
  lines.push(
    `总净差 ${yuan(s.deltaCentsTotal)} = 规则价差 ${yuan(s.ruleDeltaCentsTotal)} + 迟到/缺片缺口 ${yuan(s.dataGapCentsTotal)}。`
  );
  lines.push("");
  lines.push(`| 风险原因 | 涉及会话 | 金额/计数 |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| 新旧规则价差 | ${r.risk.byCause.rulePricing.sessions} | ${yuan(r.risk.byCause.rulePricing.cents)} |`);
  lines.push(
    `| 迟到/缺片数据缺口 | ${r.risk.byCause.lateOrMissing.sessions} | ${yuan(r.risk.byCause.lateOrMissing.cents)} |`
  );
  lines.push(
    `| 异常复位 | ${r.risk.byCause.abnormalReset.sessions} | ${r.risk.byCause.abnormalReset.resetEvents} 次复位 / ${r.risk.byCause.abnormalReset.negativeIncrements} 个负增量 |`
  );
  lines.push(
    `| 负增量 | ${r.risk.byCause.negativeIncrement.sessions} | ${r.risk.byCause.negativeIncrement.count} 个 |`
  );
  lines.push(`| 跨零点切段 | ${r.risk.byCause.crossesMidnight.sessions} | — |`);
  lines.push("");

  const renderDevices = (title: string, list: DeviceReportRow[]) => {
    lines.push(`### ${title}（${list.length}）`);
    if (list.length === 0) {
      lines.push("");
      lines.push("无。");
      lines.push("");
      return;
    }
    lines.push("");
    lines.push("| 设备 | 站点/型号/校准批 | 会话 | 负增量率 | 缺片率 | 金额差(绝对) | 裁决原因 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const d of list) {
      lines.push(
        `| ${d.deviceId}${d.state === "isolated" ? " 🔒" : ""} | ${d.siteId}/${d.model}/${d.calibrationBatch} | ${d.sessionCount} | ${pct(d.negativeRate)} | ${pct(d.missingRate)} | ${yuan(d.amountDiffAbsCents)} | ${d.reasons.join("；") || "全部门槛内"} |`
      );
    }
    lines.push("");
  };
  renderDevices("可晋级", r.devices.promote);
  renderDevices("必须隔离", r.devices.isolate);
  renderDevices("样本不足", r.devices.pending);

  lines.push("### 差异最大的会话（前 10）");
  lines.push("");
  lines.push("| 会话 | 设备 | 已封账 | 候选 | 净差 | 规则价差 | 数据缺口 | 标记 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const x of r.risk.topSessions) {
    lines.push(
      `| \`${x.sessionId.slice(0, 8)}\` | ${x.deviceId} | ${yuan(x.bookedCents)} | ${yuan(x.candidateCents)} | ${yuan(x.deltaCents)} | ${yuan(x.ruleDeltaCents)} | ${yuan(x.dataGapCents)} | ${x.flags.map((f) => FLAG_LABELS[f] ?? f).join("、")} |`
    );
  }
  lines.push("");

  lines.push("## 审批");
  lines.push("");
  const roleLabel: Record<string, string> = { metering: "计量负责人", clearing: "清算负责人" };
  for (const role of ["metering", "clearing"]) {
    const a = r.approvals.find((x) => x.role === role);
    lines.push(
      a
        ? `- ${roleLabel[role]}：${a.decision === "approve" ? "✅ 已确认" : "❌ 驳回"}（${a.approver}，${a.approvedAt}）`
        : `- ${roleLabel[role]}：⏳ 待确认`
    );
  }
  lines.push("");

  if (r.adjustments.length > 0) {
    lines.push(`## 已封账账期调整建议（${r.adjustments.length}，不回改账单）`);
    lines.push("");
    lines.push("| 账期 | 设备 | 会话 | 已封账 | 建议 | 差额 | 原因 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const a of r.adjustments.slice(0, 50)) {
      lines.push(
        `| ${a.periodId} | ${a.deviceId} | \`${a.sessionId.slice(0, 8)}\` | ${yuan(a.bookedCents)} | ${yuan(a.proposedCents)} | ${yuan(a.deltaCents)} | ${a.reason} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
