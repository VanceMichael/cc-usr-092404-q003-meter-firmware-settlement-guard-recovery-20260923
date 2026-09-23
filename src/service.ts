import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { epoch, localDate, localMidnightUtc, toIso } from "./time.js";
import {
  billWithRule,
  compareRules,
  type EngineSegment,
} from "./engine.js";
import type { CandidateRule, CurrentRule, MeteringRule } from "./rules.js";

export interface Thresholds {
  maxNegativeRate: number;    // 负增量会话占比上限
  maxMissingRate: number;     // 缺片率上限（缺片 seq / 应有 seq）
  minSamples: number;         // 最少完整会话数
  maxAmountDeltaRate: number; // |候选-现行| / 现行总额 上限
  maxAmountDeltaCents: number;// |候选-现行| 绝对金额上限（分）
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxNegativeRate: 0,
  maxMissingRate: 0.02,
  minSamples: 3,
  maxAmountDeltaRate: 0.05,
  maxAmountDeltaCents: 50_000,
};

interface Row { [k: string]: unknown }

function json(v: unknown): string { return JSON.stringify(v); }

export class ConflictError extends Error {}
export class ValidationError extends Error {}

export class CanaryService {
  private nowMs: () => number;
  constructor(
    private db: DB,
    private offsetMin = Number(process.env.APP_LOCAL_UTC_OFFSET_MINUTES ?? 480),
    clock?: () => number,
  ) {
    this.nowMs = clock ?? (() => Date.now());
  }

  private nowIso(): string { return toIso(this.nowMs()); }

  // ---------- 审计 ----------
  audit(type: string, payload: Record<string, unknown>, actor = "system", waveId?: string, deviceId?: string, sessionId?: string): void {
    this.db.prepare(`INSERT INTO audit_events(at, actor, type, wave_id, device_id, session_id, payload)
      VALUES(?,?,?,?,?,?,?)`).run(toIso(Date.now()), actor, type, waveId ?? null, deviceId ?? null, sessionId ?? null, json(payload));
  }

  // ---------- 目录：设备 / 规则 / 波次 ----------
  registerDevice(input: { deviceId: string; siteId: string; model: string; calibrationBatch: string }): void {
    this.db.prepare(`INSERT INTO devices(device_id, site_id, model, calibration_batch, registered_at)
      VALUES(?,?,?,?,?)`).run(input.deviceId, input.siteId, input.model, input.calibrationBatch, this.nowIso());
  }

  registerRule(rule: MeteringRule): void {
    this.db.prepare(`INSERT INTO metering_rules(rule_version, family, definition, created_at) VALUES(?,?,?,?)`)
      .run(rule.rule_version, rule.family, json(rule), rule.created_at);
  }

  getRule(version: string): MeteringRule {
    const row = this.db.prepare("SELECT definition FROM metering_rules WHERE rule_version = ?").get(version) as Row | undefined;
    if (!row) throw new ValidationError(`规则版本不存在: ${version}`);
    return JSON.parse(row.definition as string) as MeteringRule;
  }

  createWave(input: {
    waveId: string;
    scopeSites: string[];
    scopeModels: string[];
    scopeBatches: string[];
    currentRuleVersion: string;
    candidateRuleVersion: string;
    thresholds?: Partial<Thresholds>;
  }): void {
    for (const v of [input.currentRuleVersion, input.candidateRuleVersion]) this.getRule(v);
    const rules = [this.getRule(input.currentRuleVersion), this.getRule(input.candidateRuleVersion)];
    if (rules[0].family !== "current" || rules[1].family !== "candidate") {
      throw new ValidationError("波次必须绑定一条现行规则与一条候选规则");
    }
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
    this.db.prepare(`INSERT INTO release_waves
      (wave_id, scope_sites, scope_models, scope_batches, current_rule_version, candidate_rule_version, thresholds, status, created_at)
      VALUES(?,?,?,?,?,?,?, 'running', ?)`).run(
      input.waveId, json(input.scopeSites), json(input.scopeModels), json(input.scopeBatches),
      input.currentRuleVersion, input.candidateRuleVersion, json(thresholds), this.nowIso(),
    );
    this.audit("wave.created", { scope: { sites: input.scopeSites, models: input.scopeModels, batches: input.scopeBatches } }, "system", input.waveId);
  }

  private waveRow(waveId: string): Row {
    const row = this.db.prepare("SELECT * FROM release_waves WHERE wave_id = ?").get(waveId) as Row | undefined;
    if (!row) throw new ValidationError(`波次不存在: ${waveId}`);
    return row;
  }

  waveThresholds(waveId: string): Thresholds {
    return JSON.parse(this.waveRow(waveId).thresholds as string) as Thresholds;
  }

  // ---------- 认领：唯一归属由部分唯一索引兜底 ----------
  claimDevice(waveId: string, deviceId: string, actor = "ops"): void {
    const wave = this.waveRow(waveId);
    if (wave.status !== "running") throw new ConflictError(`波次 ${waveId} 已裁决，不能再认领设备`);
    const device = this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as Row | undefined;
    if (!device) throw new ValidationError(`设备不存在: ${deviceId}`);
    if (this.db.prepare("SELECT 1 FROM device_claims WHERE device_id = ? AND status = 'isolated'").get(deviceId)) {
      throw new ConflictError(`设备 ${deviceId} 已被隔离，须显式解除隔离后才能被新波次认领`);
    }
    const sites = JSON.parse(wave.scope_sites as string) as string[];
    const models = JSON.parse(wave.scope_models as string) as string[];
    const batches = JSON.parse(wave.scope_batches as string) as string[];
    if (!sites.includes(device.site_id as string) || !models.includes(device.model as string) || !batches.includes(device.calibration_batch as string)) {
      throw new ConflictError(`设备 ${deviceId} 不在波次 ${waveId} 的站点/型号/校准批次范围内`);
    }
    const tx = this.db.transaction(() => {
      try {
        this.db.prepare(`INSERT INTO device_claims(claim_id, wave_id, device_id, status, claimed_at)
          VALUES(?,?,?, 'active', ?)`).run(randomUUID(), waveId, deviceId, this.nowIso());
      } catch (e) {
        const owner = this.db.prepare(`SELECT wave_id FROM device_claims WHERE device_id = ? AND status = 'active'`).get(deviceId) as Row | undefined;
        throw new ConflictError(`设备 ${deviceId} 已被波次 ${owner?.wave_id ?? "?"} active 认领，唯一归属不可重叠`);
      }
      this.audit("device.claimed", {}, actor, waveId, deviceId);
    });
    tx();
  }

  /** 显式解除隔离（新固件/新波次的运维动作，留痕）。 */
  releaseIsolation(deviceId: string, actor = "ops"): void {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`UPDATE device_claims SET status = 'released', released_at = ?
        WHERE device_id = ? AND status = 'isolated'`).run(this.nowIso(), deviceId);
      if (info.changes === 0) throw new ConflictError(`设备 ${deviceId} 无隔离记录`);
      this.audit("device.isolation_released", {}, actor, undefined, deviceId);
    });
    tx();
  }

  /** 归属中的认领：active（裁决前）或 promoted（晋级后、回滚前）。 */
  private activeClaim(deviceId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM device_claims WHERE device_id = ? AND status IN ('active', 'promoted')")
      .get(deviceId) as Row | undefined;
  }

  /** 按会话开始时刻解析归属波次：优先归属中认领，其次时间区间覆盖的历史认领。 */
  private claimAtStartedAt(deviceId: string, startedAt: string): Row | undefined {
    const active = this.activeClaim(deviceId);
    if (active) return active;
    const ms = epoch(startedAt);
    return this.db.prepare(`SELECT * FROM device_claims WHERE device_id = ? AND status = 'released'
      AND claimed_at <= ? AND released_at > ?
      ORDER BY claimed_at DESC LIMIT 1`).get(deviceId, toIso(ms), toIso(ms)) as Row | undefined;
  }

  // ---------- 签到：幂等，迟到允许 ----------
  checkin(input: {
    deviceId: string; firmwareVersion: string; firmwareDigest: string;
    installedAt: string; rollbackReason?: string; observedAt?: string;
  }): { checkinId: string; deduplicated: boolean } {
    const claim = this.activeClaim(input.deviceId);
    if (!claim) throw new ConflictError(`设备 ${input.deviceId} 没有 active 波次认领，无法签到`);
    const existing = this.db.prepare(`SELECT checkin_id FROM device_checkins
      WHERE device_id = ? AND firmware_digest = ? AND installed_at = ?`)
      .get(input.deviceId, input.firmwareDigest, input.installedAt) as Row | undefined;
    if (existing) return { checkinId: existing.checkin_id as string, deduplicated: true };
    const id = randomUUID();
    this.db.prepare(`INSERT INTO device_checkins
      (checkin_id, device_id, wave_id, firmware_version, firmware_digest, installed_at, rollback_reason, observed_at, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, input.deviceId, claim.wave_id, input.firmwareVersion, input.firmwareDigest,
      input.installedAt, input.rollbackReason ?? null, input.observedAt ?? this.nowIso(), this.nowIso(),
    );
    this.audit("device.checkin", {
      firmware: { version: input.firmwareVersion, digest: input.firmwareDigest },
      installedAt: input.installedAt,
      rollbackReason: input.rollbackReason ?? null,
    }, "device", claim.wave_id as string, input.deviceId);
    return { checkinId: id, deduplicated: false };
  }

  // ---------- 会话与片段 ----------
  ingestSession(input: { sessionId: string; deviceId: string; startedAt: string; endedAt?: string }): void {
    if (this.db.prepare("SELECT 1 FROM device_claims WHERE device_id = ? AND status = 'isolated'").get(input.deviceId)) {
      throw new ConflictError(`设备 ${input.deviceId} 已隔离，禁止开启新会话`);
    }
    const claim = this.claimAtStartedAt(input.deviceId, input.startedAt);
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO sessions(session_id, device_id, wave_id, started_at, ended_at, is_complete, first_seen_at, last_update_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET ended_at = excluded.ended_at,
          is_complete = CASE WHEN excluded.ended_at IS NOT NULL THEN 1 ELSE sessions.is_complete END,
          last_update_at = excluded.last_update_at`).run(
        input.sessionId, input.deviceId, claim?.wave_id ?? null, input.startedAt,
        input.endedAt ?? null, input.endedAt ? 1 : 0, this.nowIso(), this.nowIso(),
      );
    });
    tx();
  }

  /** 片段幂等：同 (session, seq) 重复回报走 upsert，不新建记录。跨固件版本表读数原样保留。 */
  ingestSegment(input: {
    sessionId: string; seq: number; startReadingMwh: number; endReadingMwh: number;
    startedAt: string; endedAt: string; resetAfterPrevious?: boolean;
  }): { segmentId: string; deduplicated: boolean } {
    const session = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(input.sessionId) as Row | undefined;
    if (!session) throw new ValidationError(`会话不存在: ${input.sessionId}`);
    if (input.endReadingMwh < 0 || input.startReadingMwh < 0) throw new ValidationError("表读数不能为负");
    const checkin = this.db.prepare(`SELECT * FROM device_checkins WHERE device_id = ? AND installed_at <= ?
      ORDER BY installed_at DESC LIMIT 1`).get(session.device_id, input.startedAt) as Row | undefined;
    const sealedDate = localDate(epoch(input.startedAt), this.offsetMin);
    const period = this.db.prepare("SELECT status FROM billing_periods WHERE period_date = ?").get(sealedDate) as Row | undefined;
    const arrivedAfterSeal = period?.status === "sealed" ? 1 : 0;
    const segmentId = `${input.sessionId}:${input.seq}`;
    let deduplicated = false;
    const tx = this.db.transaction(() => {
      deduplicated = Boolean(
        this.db.prepare("SELECT 1 FROM segments WHERE session_id = ? AND seq = ?").get(input.sessionId, input.seq),
      );
      this.db.prepare(`INSERT INTO segments
        (segment_id, session_id, seq, checkin_id, start_reading_mwh, end_reading_mwh,
         started_at, ended_at, reset_after_previous, arrived_after_seal, received_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id, seq) DO UPDATE SET
          checkin_id = excluded.checkin_id,
          start_reading_mwh = excluded.start_reading_mwh,
          end_reading_mwh = excluded.end_reading_mwh,
          started_at = excluded.started_at, ended_at = excluded.ended_at,
          reset_after_previous = excluded.reset_after_previous,
          arrived_after_seal = MAX(segments.arrived_after_seal, excluded.arrived_after_seal)`).run(
        segmentId, input.sessionId, input.seq, checkin?.checkin_id ?? null,
        input.startReadingMwh, input.endReadingMwh, input.startedAt, input.endedAt,
        input.resetAfterPrevious ? 1 : 0, arrivedAfterSeal, this.nowIso(),
      );
      this.db.prepare("UPDATE sessions SET last_update_at = ? WHERE session_id = ?").run(this.nowIso(), input.sessionId);
    });
    tx();
    return { segmentId, deduplicated };
  }

  segmentsOfSession(sessionId: string): EngineSegment[] {
    const rows = this.db.prepare(`SELECT * FROM segments WHERE session_id = ? ORDER BY seq`).all(sessionId) as Row[];
    return rows.map((r) => ({
      seq: r.seq as number,
      start_reading_mwh: r.start_reading_mwh as number,
      end_reading_mwh: r.end_reading_mwh as number,
      started_at: r.started_at as string,
      ended_at: r.ended_at as string,
      reset_after_previous: Boolean(r.reset_after_previous),
    }));
  }

  // ---------- 账期封账与生效规则 ----------
  /**
   * 会话生效规则：波次晋级且该设备裁决 promote、会话开始不早于晋级时刻用候选规则；
   * 若会话开始前最近一次签到携带回滚缘由，则仍用现行规则（回滚期间的会话）。
   */
  effectiveRuleForSession(session: Row): { rule: MeteringRule; ruleVersion: string } {
    const waveId = session.wave_id as string | null;
    const fallback = (): MeteringRule => {
      const v = waveId ? (this.waveRow(waveId).current_rule_version as string) : "metering-v1";
      return this.db.prepare("SELECT definition FROM metering_rules WHERE rule_version = ?").get(v)
        ? this.getRule(v) : this.getRule("metering-v1");
    };
    if (!waveId) return { rule: fallback(), ruleVersion: waveId ? this.waveRow(waveId).current_rule_version as string : "metering-v1" };
    const wave = this.waveRow(waveId);
    const promotedAt = wave.promoted_at ? epoch(wave.promoted_at as string) : null;
    const verdict = this.db.prepare("SELECT decision FROM wave_device_verdicts WHERE wave_id = ? AND device_id = ?")
      .get(waveId, session.device_id) as Row | undefined;
    const latestCheckin = this.db.prepare(`SELECT * FROM device_checkins WHERE device_id = ? AND installed_at <= ?
      ORDER BY installed_at DESC LIMIT 1`).get(session.device_id, session.started_at) as Row | undefined;
    const rolledBack = Boolean(latestCheckin?.rollback_reason);
    if (promotedAt && wave.status !== "rolled_back" && epoch(session.started_at as string) >= promotedAt
      && verdict?.decision === "promote" && !rolledBack) {
      return { rule: this.getRule(wave.candidate_rule_version as string), ruleVersion: wave.candidate_rule_version as string };
    }
    return { rule: this.getRule(wave.current_rule_version as string), ruleVersion: wave.current_rule_version as string };
  }

  /** 封账：对该账期内所有完整会话按生效规则出账并写入 booked；已封账不接受再次封账。 */
  sealPeriod(date: string, actor = "clearing"): { booked: number } {
    const period = this.db.prepare("SELECT * FROM billing_periods WHERE period_date = ?").get(date) as Row | undefined;
    if (period?.status === "sealed") throw new ConflictError(`账期 ${date} 已封账，迟到数据不得改写`);
    const dayStart = localMidnightUtc(date, this.offsetMin);
    const sessions = this.db.prepare(`SELECT * FROM sessions WHERE is_complete = 1
      AND started_at >= ? AND started_at < ?`).all(toIso(dayStart - 86_400_000), toIso(dayStart + 86_400_000)) as Row[];
    let booked = 0;
    const tx = this.db.transaction(() => {
      for (const s of sessions) {
        const segs = this.segmentsOfSession(s.session_id as string);
        if (segs.length === 0) continue;
        const { rule, ruleVersion } = this.effectiveRuleForSession(s);
        const result = billWithRule(segs, rule, this.offsetMin);
        const amount = result.perPeriod[date] ?? 0;
        if (amount === 0) continue;
        const settlementId = `${s.session_id}:${date}`;
        this.db.prepare(`INSERT INTO session_settlements
          (settlement_id, session_id, period_date, wave_id, rule_version, amount_cents, status, created_at)
          VALUES(?,?,?,?,?,?, 'booked', ?)
          ON CONFLICT DO NOTHING`).run(
          settlementId, s.session_id, date, s.wave_id, ruleVersion, amount, this.nowIso(),
        );
        booked += 1;
      }
      this.db.prepare(`INSERT INTO billing_periods(period_date, status, sealed_at) VALUES(?, 'sealed', ?)
        ON CONFLICT(period_date) DO UPDATE SET status = 'sealed', sealed_at = excluded.sealed_at`).run(date, this.nowIso());
      this.audit("period.sealed", { date, bookedSessions: booked }, actor);
    });
    tx();
    return { booked };
  }

  isPeriodSealed(date: string): boolean {
    return (this.db.prepare("SELECT status FROM billing_periods WHERE period_date = ?").get(date) as Row | undefined)?.status === "sealed";
  }

  // ---------- 审批、晋级、回滚 ----------
  approve(waveId: string, role: "metering_lead" | "clearing_lead", approver: string, decision: "approved" | "rejected", comment?: string): void {
    this.waveRow(waveId);
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO wave_approvals(wave_id, role, approver, decision, comment, decided_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(wave_id, role) DO UPDATE SET approver = excluded.approver, decision = excluded.decision,
          comment = excluded.comment, decided_at = excluded.decided_at`)
        .run(waveId, role, approver, decision, comment ?? null, this.nowIso());
      this.audit("wave.approval", { role, approver, decision, comment: comment ?? null }, approver, waveId);
    });
    tx();
  }

  private isolatedDeviceIds(waveId: string): string[] {
    return (this.db.prepare("SELECT device_id FROM device_claims WHERE wave_id = ? AND status = 'isolated'").all(waveId) as Row[])
      .map((r) => r.device_id as string);
  }

  promote(waveId: string, actor = "ops"): void {
    const wave = this.waveRow(waveId);
    if (wave.status !== "decided") throw new ConflictError("波次尚未完成裁决，不能晋级");
    const approvals = this.db.prepare("SELECT role, decision FROM wave_approvals WHERE wave_id = ?").all(waveId) as Row[];
    const byRole = new Map(approvals.map((a) => [a.role, a.decision]));
    if (byRole.get("metering_lead") !== "approved" || byRole.get("clearing_lead") !== "approved") {
      throw new ConflictError("须计量负责人与清算负责人双签 approved 后才能晋级");
    }
    const tx = this.db.transaction(() => {
      // 裁决 promote 的设备转为 promoted：后续会话按候选规则出账；
      // blocked（样本不足）的 active 认领释放；quarantine 设备已在裁决时隔离。
      this.db.prepare(`UPDATE device_claims SET status = 'promoted'
        WHERE wave_id = ? AND status = 'active' AND device_id IN (
          SELECT device_id FROM wave_device_verdicts WHERE wave_id = ? AND decision = 'promote'
        )`).run(waveId, waveId);
      this.db.prepare(`UPDATE device_claims SET status = 'released', released_at = ?
        WHERE wave_id = ? AND status = 'active'`).run(this.nowIso(), waveId);
      this.db.prepare("UPDATE release_waves SET status = 'promoted', promoted_at = ? WHERE wave_id = ?").run(this.nowIso(), waveId);
      this.audit("wave.promoted", {
        candidateRule: wave.candidate_rule_version,
        isolatedDevices: this.isolatedDeviceIds(waveId),
      }, actor, waveId);
    });
    tx();
  }

  rollback(waveId: string, reason: string, actor = "ops"): void {
    const wave = this.waveRow(waveId);
    if (wave.promoted_at === null && wave.status === "running") throw new ConflictError("未晋级的波次直接终止即可，无需回滚");
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE release_waves SET status = 'rolled_back', rolled_back_at = ? WHERE wave_id = ?").run(this.nowIso(), waveId);
      this.db.prepare(`UPDATE device_claims SET status = 'released', released_at = ?
        WHERE wave_id = ? AND status IN ('active', 'promoted')`).run(this.nowIso(), waveId);
      // 已按候选规则 booked 的结算行原样保留（回滚也保留其间采用过的规则），仅记录事件。
      const kept = this.db.prepare(`SELECT settlement_id, period_date, rule_version, amount_cents FROM session_settlements
        WHERE wave_id = ? AND rule_version = ? AND status = 'booked'`).all(waveId, wave.candidate_rule_version) as Row[];
      this.audit("wave.rolled_back", { reason, keptCandidateBookings: kept }, actor, waveId);
    });
    tx();
  }
}
