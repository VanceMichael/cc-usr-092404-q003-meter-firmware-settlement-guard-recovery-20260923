import type { Database as DB } from "better-sqlite3";
import { ValidationError, type Thresholds } from "./service.js";
import type { DeltaComponents } from "./engine.js";

interface Row { [k: string]: unknown }

export interface ConservationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DeviceReportRow {
  deviceId: string;
  siteId: string;
  model: string;
  calibrationBatch: string;
  firmwareVersion: string;
  firmwareDigest: string;
  decision: string;
  reasons: string[];
  metrics: Record<string, unknown>;
}

export interface WaveReport {
  waveId: string;
  status: string;
  scope: { sites: string[]; models: string[]; batches: string[] };
  rules: { current: string; candidate: string };
  thresholds: Thresholds;
  generatedAt: string;
  approvals: Array<{ role: string; approver: string; decision: string; comment: string | null; at: string }>;
  sessionsCompared: number;
  devices: DeviceReportRow[];
  totals: {
    devices: number;
    promote: number;
    quarantine: number;
    blocked: number;
    currentCents: number;
    candidateCents: number;
    deltaCents: number;
  };
  riskByComponent: { midnightTransferCents: number; resetCents: number; priceCents: number };
  riskByPeriod: Array<{ date: string; currentCents: number; candidateCents: number; deltaCents: number }>;
  checks: ConservationCheck[];
}

export class Reporting {
  constructor(private db: DB) {}

  private wave(waveId: string): Row {
    const row = this.db.prepare("SELECT * FROM release_waves WHERE wave_id = ?").get(waveId) as Row | undefined;
    if (!row) throw new ValidationError(`波次不存在: ${waveId}`);
    return row;
  }

  buildWaveReport(waveId: string): WaveReport {
    const wave = this.wave(waveId);
    const comparisons = this.db.prepare(`SELECT sc.*, s.device_id FROM session_comparisons sc
      JOIN sessions s ON s.session_id = sc.session_id WHERE sc.wave_id = ?`).all(waveId) as Array<Row & {
        components: string; per_period: string
      }>;
    const verdictRows = this.db.prepare("SELECT * FROM wave_device_verdicts WHERE wave_id = ?").all(waveId) as Row[];
    const claimRows = this.db.prepare("SELECT * FROM device_claims WHERE wave_id = ?").all(waveId) as Row[];

    let midnightCents = 0;
    let resetCents = 0;
    let priceCents = 0;
    let currentCents = 0;
    let candidateCents = 0;
    const byPeriod = new Map<string, { current: number; candidate: number }>();

    for (const c of comparisons) {
      const comp = JSON.parse(c.components as string) as DeltaComponents;
      midnightCents += Object.values(comp.midnightTransfer).reduce((a, b) => a + b, 0);
      resetCents += Object.values(comp.reset).reduce((a, b) => a + b, 0);
      priceCents += Object.values(comp.price).reduce((a, b) => a + b, 0);
      currentCents += c.current_cents as number;
      candidateCents += c.candidate_cents as number;
      for (const p of JSON.parse(c.per_period as string) as Array<{ date: string; currentCents: number; candidateCents: number }>) {
        const bucket = byPeriod.get(p.date) ?? { current: 0, candidate: 0 };
        bucket.current += p.currentCents;
        bucket.candidate += p.candidateCents;
        byPeriod.set(p.date, bucket);
      }
    }

    const devices: DeviceReportRow[] = claimRows.map((claim) => {
      const device = this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(claim.device_id) as Row;
      const verdict = verdictRows.find((v) => v.device_id === claim.device_id);
      const checkin = this.db.prepare(`SELECT firmware_version, firmware_digest FROM device_checkins
        WHERE wave_id = ? AND device_id = ? ORDER BY installed_at DESC LIMIT 1`).get(waveId, claim.device_id) as Row | undefined;
      return {
        deviceId: claim.device_id as string,
        siteId: device.site_id as string,
        model: device.model as string,
        calibrationBatch: device.calibration_batch as string,
        firmwareVersion: (checkin?.firmware_version as string) ?? "unknown",
        firmwareDigest: (checkin?.firmware_digest as string) ?? "unknown",
        decision: (verdict?.decision as string) ?? "pending",
        reasons: verdict ? JSON.parse(verdict.reasons as string) as string[] : [],
        metrics: verdict ? JSON.parse(verdict.metrics as string) : {},
      };
    });

    const counts = { promote: 0, quarantine: 0, blocked: 0 };
    for (const d of devices) {
      if (d.decision in counts) counts[d.decision as keyof typeof counts] += 1;
    }

    const checks = this.conservationChecks(waveId, comparisons, { midnightCents, resetCents, priceCents }, currentCents, candidateCents);

    return {
      waveId,
      status: wave.status as string,
      scope: {
        sites: JSON.parse(wave.scope_sites as string),
        models: JSON.parse(wave.scope_models as string),
        batches: JSON.parse(wave.scope_batches as string),
      },
      rules: { current: wave.current_rule_version as string, candidate: wave.candidate_rule_version as string },
      thresholds: JSON.parse(wave.thresholds as string),
      generatedAt: new Date().toISOString(),
      approvals: (this.db.prepare("SELECT role, approver, decision, comment, decided_at FROM wave_approvals WHERE wave_id = ? ORDER BY role")
        .all(waveId) as Row[]).map((a) => ({
          role: a.role as string, approver: a.approver as string, decision: a.decision as string,
          comment: (a.comment as string | null) ?? null, at: a.decided_at as string,
        })),
      sessionsCompared: comparisons.length,
      devices,
      totals: {
        devices: devices.length,
        promote: counts.promote,
        quarantine: counts.quarantine,
        blocked: counts.blocked,
        currentCents,
        candidateCents,
        deltaCents: candidateCents - currentCents,
      },
      riskByComponent: { midnightTransferCents: midnightCents, resetCents, priceCents },
      riskByPeriod: [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({
        date,
        currentCents: v.current,
        candidateCents: v.candidate,
        deltaCents: v.candidate - v.current,
      })),
      checks,
    };
  }

  /** 守恒校验：分量恒等、跨零点净额为零（只允许整数分四舍五入残差）、设备/会话两级合计一致。 */
  conservationChecks(
    waveId: string,
    comparisons: Array<Row & { components: string }>,
    componentsSum: { midnightCents: number; resetCents: number; priceCents: number },
    currentCents: number,
    candidateCents: number,
  ): ConservationCheck[] {
    const checks: ConservationCheck[] = [];

    // 1) 会话级：每会话 delta == midnight + reset + price（按账期分项合计）
    let badIdentity = 0;
    for (const c of comparisons) {
      const comp = JSON.parse(c.components as string) as DeltaComponents;
      const sum =
        Object.values(comp.midnightTransfer).reduce((a, b) => a + b, 0)
        + Object.values(comp.reset).reduce((a, b) => a + b, 0)
        + Object.values(comp.price).reduce((a, b) => a + b, 0);
      if (sum !== (c.delta_cents as number)) badIdentity += 1;
    }
    checks.push({
      name: "分量恒等：每会话 Δ = 跨零点 + 复位 + 价差",
      passed: badIdentity === 0,
      detail: badIdentity === 0 ? `${comparisons.length} 个会话全部恒等` : `${badIdentity} 个会话不恒等`,
    });

    // 2) 波次级分量恒等
    const componentTotal = componentsSum.midnightCents + componentsSum.resetCents + componentsSum.priceCents;
    const waveDelta = candidateCents - currentCents;
    checks.push({
      name: "波次分量合计 = 波次金额差异",
      passed: componentTotal === waveDelta,
      detail: `分量合计 ${componentTotal} 分，差异 ${waveDelta} 分`,
    });

    // 3) 跨零点只迁移归属，不创造金额（残差来自各片独立四舍五入）
    const residual = Math.abs(componentsSum.midnightCents);
    const cap = Math.max(comparisons.length, 1); // 每会话至多 ±1 分级别残差
    checks.push({
      name: "跨零点迁移净额≈0（不创造金额）",
      passed: residual <= cap,
      detail: `净额 ${componentsSum.midnightCents} 分（容差 ${cap} 分，四舍五入残差）`,
    });

    // 4) 设备级合计 == 会话级合计
    const deviceRows = this.db.prepare("SELECT metrics FROM wave_device_verdicts WHERE wave_id = ?").all(waveId) as Row[];
    const deviceCurrent = deviceRows.reduce((s, r) => s + ((JSON.parse(r.metrics as string) as { currentCents: number }).currentCents), 0);
    const deviceCandidate = deviceRows.reduce((s, r) => s + ((JSON.parse(r.metrics as string) as { candidateCents: number }).candidateCents), 0);
    checks.push({
      name: "设备汇总 = 会话明细汇总",
      passed: deviceCurrent === currentCents && deviceCandidate === candidateCents,
      detail: `设备级 ${deviceCurrent}/${deviceCandidate} 分，会话级 ${currentCents}/${candidateCents} 分（现行/候选）`,
    });

    return checks;
  }

  /** 一笔差异反查：固件、规则、读数区间、审批版本、分量。 */
  traceDifference(waveId: string, sessionId: string) {
    const sc = this.db.prepare(`SELECT * FROM session_comparisons WHERE wave_id = ? AND session_id = ?`).get(waveId, sessionId) as Row | undefined;
    if (!sc) throw new ValidationError(`找不到该波次/会话的比较结果: ${waveId}/${sessionId}`);
    const session = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Row;
    const device = this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(session.device_id) as Row;
    const wave = this.wave(waveId);
    const segments = this.db.prepare(`SELECT g.*, ck.firmware_version, ck.firmware_digest, ck.installed_at AS firmware_installed_at, ck.rollback_reason
      FROM segments g LEFT JOIN device_checkins ck ON ck.checkin_id = g.checkin_id
      WHERE g.session_id = ? ORDER BY g.seq`).all(sessionId) as Row[];
    const approvals = this.db.prepare("SELECT * FROM wave_approvals WHERE wave_id = ? ORDER BY role").all(waveId) as Row[];
    const run = this.db.prepare("SELECT * FROM comparison_runs WHERE run_id = ?").get(sc.run_id) as Row;
    const settlements = this.db.prepare("SELECT * FROM session_settlements WHERE session_id = ? ORDER BY period_date").all(sessionId) as Row[];
    const advices = this.db.prepare("SELECT * FROM adjustment_advices WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[];
    return {
      wave: {
        waveId,
        status: wave.status,
        currentRuleVersion: wave.current_rule_version,
        candidateRuleVersion: wave.candidate_rule_version,
        currentRuleDefinition: JSON.parse((this.db.prepare("SELECT definition FROM metering_rules WHERE rule_version = ?").get(wave.current_rule_version) as Row).definition as string),
        candidateRuleDefinition: JSON.parse((this.db.prepare("SELECT definition FROM metering_rules WHERE rule_version = ?").get(wave.candidate_rule_version) as Row).definition as string),
      },
      session: {
        sessionId,
        deviceId: session.device_id,
        siteId: device.site_id,
        model: device.model,
        calibrationBatch: device.calibration_batch,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        inputHash: sc.input_hash,
      },
      readings: segments.map((g) => ({
        seq: g.seq,
        interval: [g.started_at, g.ended_at],
        startReadingMwh: g.start_reading_mwh,
        endReadingMwh: g.end_reading_mwh,
        deltaMwh: (g.end_reading_mwh as number) - (g.start_reading_mwh as number),
        resetAfterPrevious: Boolean(g.reset_after_previous),
        arrivedAfterSeal: Boolean(g.arrived_after_seal),
        firmware: g.firmware_version ? {
          version: g.firmware_version,
          digest: g.firmware_digest,
          installedAt: g.firmware_installed_at,
          rollbackReason: g.rollback_reason,
        } : null,
      })),
      money: {
        currentCents: sc.current_cents,
        candidateCents: sc.candidate_cents,
        deltaCents: sc.delta_cents,
        components: JSON.parse(sc.components as string),
        perPeriod: JSON.parse(sc.per_period as string),
        negativeCount: sc.negative_count,
        resetCount: sc.reset_count,
        missingRate: sc.missing_rate,
      },
      approvals: approvals.map((a) => ({ role: a.role, approver: a.approver, decision: a.decision, comment: a.comment, at: a.decided_at })),
      comparisonRun: { runId: sc.run_id, status: run.status, comparedAt: sc.compared_at },
      settlements: settlements.map((s) => ({
        periodDate: s.period_date, ruleVersion: s.rule_version, amountCents: s.amount_cents, status: s.status,
      })),
      adjustmentAdvices: advices.map((a) => ({
        periodDate: a.period_date, bookedRuleVersion: a.booked_rule_version, bookedCents: a.booked_cents,
        advisedRuleVersion: a.advised_rule_version, advisedCents: a.advised_cents, deltaCents: a.delta_cents,
        reason: a.reason, status: a.status,
      })),
    };
  }
}
