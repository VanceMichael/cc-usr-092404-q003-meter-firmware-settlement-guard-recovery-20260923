import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { CanaryService, ConflictError, ValidationError, type Thresholds } from "./service.js";
import { billWithRule, compareRules } from "./engine.js";

interface Row { [k: string]: unknown }
function json(v: unknown): string { return JSON.stringify(v); }
function nowIso(): string { return new Date().toISOString(); }

export interface DeviceMetrics {
  samples: number;
  negativeSessions: number;
  negativeRate: number;
  maxMissingRate: number;
  resetSessions: number;
  currentCents: number;
  candidateCents: number;
  deltaCents: number;
  deltaRate: number;
}

export interface DeviceVerdict {
  waveId: string;
  deviceId: string;
  decision: "promote" | "quarantine" | "blocked";
  reasons: string[];
  metrics: DeviceMetrics;
}

/**
 * 可续算比较作业：以会话为最小事务单元，已完成会话写入 session_comparisons；
 * 中断后再次运行自动跳过已有结果，从下一个未完成会话续算。
 */
export class ComparisonJob {
  constructor(private svc: CanaryService, private db: DB) {}

  startRun(waveId: string, batchLimit?: number): { runId: string; done: number; total: number; remaining: boolean } {
    const exists = this.db.prepare("SELECT 1 FROM release_waves WHERE wave_id = ?").get(waveId);
    if (!exists) throw new ValidationError(`波次不存在: ${waveId}`);
    const runId = randomUUID();
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM sessions s
      JOIN device_claims c ON c.device_id = s.device_id AND c.wave_id = ?
      WHERE s.is_complete = 1`).get(waveId) as Row).c as number;
    this.db.prepare(`INSERT INTO comparison_runs(run_id, wave_id, status, sessions_total, sessions_done, started_at)
      VALUES(?,?, 'running', ?, 0, ?)`).run(runId, waveId, total, nowIso());
    return this.resumeRun(waveId, runId, batchLimit);
  }

  /** 找到波次最近一个未完成的 run 续算；没有则新建。 */
  runToCompletion(waveId: string, batchLimit?: number): { runId: string; done: number; total: number; remaining: boolean } {
    const row = this.db.prepare(`SELECT run_id FROM comparison_runs WHERE wave_id = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`).get(waveId) as Row | undefined;
    return row ? this.resumeRun(waveId, row.run_id as string, batchLimit) : this.startRun(waveId, batchLimit);
  }

  resumeRun(waveId: string, runId: string, batchLimit?: number): { runId: string; done: number; total: number; remaining: boolean } {
    const wave = this.db.prepare("SELECT * FROM release_waves WHERE wave_id = ?").get(waveId) as Row | undefined;
    if (!wave) throw new ValidationError(`波次不存在: ${waveId}`);
    const currentRule = this.svc.getRule(wave.current_rule_version as string);
    const candidateRule = this.svc.getRule(wave.candidate_rule_version as string);
    if (currentRule.family !== "current" || candidateRule.family !== "candidate") {
      throw new Error("波次规则族异常");
    }
    const pending = this.db.prepare(`SELECT s.session_id FROM sessions s
      JOIN device_claims c ON c.device_id = s.device_id AND c.wave_id = ?
      LEFT JOIN session_comparisons sc ON sc.session_id = s.session_id AND sc.wave_id = ?
      WHERE s.is_complete = 1 AND sc.session_id IS NULL
      ORDER BY s.started_at, s.session_id`).all(waveId, waveId) as Row[];

    let processed = 0;
    for (const p of pending) {
      if (batchLimit !== undefined && processed >= batchLimit) break;
      const sessionId = p.session_id as string;
      const segments = this.svc.segmentsOfSession(sessionId);
      if (segments.length === 0) continue;
      const outcome = compareRulesWith(segments, currentRule, candidateRule);
      const tx = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO session_comparisons
          (wave_id, session_id, run_id, input_hash, current_cents, candidate_cents, delta_cents,
           components, per_period, negative_count, reset_count, missing_rate, compared_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(wave_id, session_id) DO UPDATE SET
            run_id = excluded.run_id, input_hash = excluded.input_hash,
            current_cents = excluded.current_cents, candidate_cents = excluded.candidate_cents,
            delta_cents = excluded.delta_cents, components = excluded.components, per_period = excluded.per_period,
            negative_count = excluded.negative_count, reset_count = excluded.reset_count,
            missing_rate = excluded.missing_rate, compared_at = excluded.compared_at`).run(
          waveId, sessionId, runId, outcome.inputHash,
          outcome.current.totalCents, outcome.candidate.totalCents, outcome.deltaCents,
          json(outcome.components), json(perPeriodRows(outcome)),
          outcome.current.negativeCount, outcome.current.resetCount, outcome.missingRate, nowIso(),
        );
        this.db.prepare("UPDATE comparison_runs SET sessions_done = (SELECT COUNT(*) FROM session_comparisons WHERE wave_id = ?) WHERE run_id = ?")
          .run(waveId, runId);
      });
      tx();
      processed += 1;
    }

    const run = this.db.prepare("SELECT * FROM comparison_runs WHERE run_id = ?").get(runId) as Row;
    const done = run.sessions_done as number;
    const total = run.sessions_total as number;
    const remaining = done < total;
    if (!remaining) {
      this.db.prepare("UPDATE comparison_runs SET status = 'done', finished_at = ? WHERE run_id = ?").run(nowIso(), runId);
    }
    return { runId, done, total, remaining };
  }
}

// 比较作业按会话提交；规则对象直接传入引擎。
function compareRulesWith(segments: Parameters<typeof compareRules>[0], current: Parameters<typeof compareRules>[1], candidate: Parameters<typeof compareRules>[2]) {
  const offsetMin = Number(process.env.APP_LOCAL_UTC_OFFSET_MINUTES ?? 480);
  return compareRules(segments, current, candidate, offsetMin);
}

function perPeriodRows(outcome: ReturnType<typeof compareRules>): Array<{ date: string; currentCents: number; candidateCents: number }> {
  const dates = new Set([...Object.keys(outcome.current.perPeriod), ...Object.keys(outcome.candidate.perPeriod)]);
  return [...dates].sort().map((date) => ({
    date,
    currentCents: outcome.current.perPeriod[date] ?? 0,
    candidateCents: outcome.candidate.perPeriod[date] ?? 0,
  }));
}

export class Adjudication {
  constructor(private svc: CanaryService, private db: DB) {}

  deviceMetrics(waveId: string, deviceId: string): DeviceMetrics {
    const rows = this.db.prepare(`SELECT sc.* FROM session_comparisons sc
      JOIN sessions s ON s.session_id = sc.session_id
      WHERE sc.wave_id = ? AND s.device_id = ?`).all(waveId, deviceId) as Row[];
    const samples = rows.length;
    const negativeSessions = rows.filter((r) => (r.negative_count as number) > 0).length;
    const resetSessions = rows.filter((r) => (r.reset_count as number) > 0).length;
    const currentCents = rows.reduce((s, r) => s + (r.current_cents as number), 0);
    const candidateCents = rows.reduce((s, r) => s + (r.candidate_cents as number), 0);
    const deltaCents = candidateCents - currentCents;
    return {
      samples,
      negativeSessions,
      negativeRate: samples ? negativeSessions / samples : 0,
      maxMissingRate: rows.reduce((m, r) => Math.max(m, r.missing_rate as number), 0),
      resetSessions,
      currentCents,
      candidateCents,
      deltaCents,
      deltaRate: currentCents ? Math.abs(deltaCents) / currentCents : deltaCents === 0 ? 0 : Infinity,
    };
  }

  /** 对波次内全部已认领设备出裁决；超限设备当场置为 isolated。 */
  decide(waveId: string, actor = "system"): DeviceVerdict[] {
    const wave = this.db.prepare("SELECT * FROM release_waves WHERE wave_id = ?").get(waveId) as Row | undefined;
    if (!wave) throw new ValidationError(`波次不存在: ${waveId}`);
    const thresholds = JSON.parse(wave.thresholds as string) as Thresholds;
    const run = this.db.prepare(`SELECT status FROM comparison_runs WHERE wave_id = ? ORDER BY started_at DESC LIMIT 1`).get(waveId) as Row | undefined;
    if (run?.status !== "done") throw new ConflictError("比较作业尚未跑到完成，不能裁决");

    const devices = (this.db.prepare("SELECT DISTINCT device_id FROM device_claims WHERE wave_id = ?").all(waveId) as Row[])
      .map((r) => r.device_id as string);
    const verdicts: DeviceVerdict[] = devices.map((deviceId) => {
      const m = this.deviceMetrics(waveId, deviceId);
      const reasons: string[] = [];
      let decision: DeviceVerdict["decision"];
      if (m.samples < thresholds.minSamples) {
        decision = "blocked";
        reasons.push(`样本量不足：${m.samples} < 门槛 ${thresholds.minSamples}`);
      } else {
        if (m.negativeRate > thresholds.maxNegativeRate)
          reasons.push(`负增量会话占比 ${(m.negativeRate * 100).toFixed(1)}% 超门槛 ${(thresholds.maxNegativeRate * 100).toFixed(1)}%`);
        if (m.maxMissingRate > thresholds.maxMissingRate)
          reasons.push(`缺片率 ${(m.maxMissingRate * 100).toFixed(1)}% 超门槛 ${(thresholds.maxMissingRate * 100).toFixed(1)}%`);
        if (m.deltaRate > thresholds.maxAmountDeltaRate)
          reasons.push(`金额差异率 ${(m.deltaRate * 100).toFixed(2)}% 超门槛 ${(thresholds.maxAmountDeltaRate * 100).toFixed(2)}%`);
        if (Math.abs(m.deltaCents) > thresholds.maxAmountDeltaCents)
          reasons.push(`金额差异 ${m.deltaCents} 分超绝对门槛 ${thresholds.maxAmountDeltaCents} 分`);
        decision = reasons.length > 0 ? "quarantine" : "promote";
      }
      return { waveId, deviceId, decision, reasons, metrics: m };
    });

    const tx = this.db.transaction(() => {
      for (const v of verdicts) {
        this.db.prepare(`INSERT INTO wave_device_verdicts(wave_id, device_id, decision, reasons, metrics, decided_at)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(wave_id, device_id) DO UPDATE SET decision = excluded.decision,
            reasons = excluded.reasons, metrics = excluded.metrics, decided_at = excluded.decided_at`)
          .run(v.waveId, v.deviceId, v.decision, json(v.reasons), json(v.metrics), nowIso());
        if (v.decision === "quarantine") {
          this.db.prepare(`UPDATE device_claims SET status = 'isolated' WHERE wave_id = ? AND device_id = ? AND status = 'active'`)
            .run(waveId, v.deviceId);
        }
        this.svc.audit("device.verdict", { decision: v.decision, reasons: v.reasons, metrics: v.metrics }, actor, waveId, v.deviceId);
      }
      this.db.prepare("UPDATE release_waves SET status = 'decided', decided_at = ? WHERE wave_id = ?").run(nowIso(), waveId);
    });
    tx();
    return verdicts;
  }
}

/**
 * 封账后迟到数据：绝不改账，只生成调整建议。
 * 用已 booked 结算的同一规则版本对当前完整片段重算，差异即迟到数据造成的建议调整额。
 */
export function generateLateAdvices(svc: CanaryService, db: DB): number {
  const booked = db.prepare(`SELECT st.* FROM session_settlements st
    JOIN billing_periods p ON p.period_date = st.period_date
    WHERE p.status = 'sealed' AND st.status = 'booked'`).all() as Row[];
  let created = 0;
  for (const b of booked) {
    const segments = svc.segmentsOfSession(b.session_id as string);
    if (segments.length === 0) continue;
    const rule = svc.getRule(b.rule_version as string);
    const recomputed = billWithRule(segments, rule, Number(process.env.APP_LOCAL_UTC_OFFSET_MINUTES ?? 480));
    const advised = recomputed.perPeriod[b.period_date as string] ?? 0;
    const delta = advised - (b.amount_cents as number);
    if (delta === 0) continue;
    const existing = db.prepare("SELECT advice_id, delta_cents FROM adjustment_advices WHERE period_date = ? AND session_id = ?")
      .get(b.period_date, b.session_id) as Row | undefined;
    const tx = db.transaction(() => {
      if (existing) {
        // 幂等：delta 未变不再写；若又有新迟到数据改变了建议额，则更新同一条，不新建。
        if ((existing.delta_cents as number) !== delta) {
          db.prepare("UPDATE adjustment_advices SET advised_cents = ?, delta_cents = ? WHERE advice_id = ?")
            .run(advised, delta, existing.advice_id);
        }
        return;
      }
      db.prepare(`INSERT INTO adjustment_advices
        (advice_id, period_date, session_id, wave_id, booked_rule_version, booked_cents,
         advised_rule_version, advised_cents, delta_cents, reason, status, created_at)
        VALUES(?,?,?,?,?,?,?,?,?, 'late_data_after_seal', 'open', ?)`).run(
        randomUUID(), b.period_date, b.session_id, b.wave_id ?? "none",
        b.rule_version, b.amount_cents, b.rule_version, advised, delta, nowIso(),
      );
      created += 1;
    });
    tx();
  }
  return created;
}
