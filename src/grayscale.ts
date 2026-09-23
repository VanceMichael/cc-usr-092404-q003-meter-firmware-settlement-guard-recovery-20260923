import { createHash, randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import {
  calculate,
  periodIdOf,
  type CalcResult,
  type FragmentInput,
  type RulePayload,
} from "./metering.js";

export type { RulePayload };

// ---------- 输入/输出类型 ----------

export interface WaveThresholds {
  /** 负增量率上限（负增量片段数 / 实收片段数） */
  maxNegativeRate: number;
  /** 缺片率上限（缺失序号数 / 期望序号数） */
  maxMissingRate: number;
  /** 最少样本会话数，不足则 pending_sample，不得晋级 */
  minSessions: number;
  /** 单设备金额相对差异上限 */
  maxAmountDiffRel: number;
}

export interface CreateWaveInput {
  waveId: string;
  name: string;
  siteIds: string[];
  deviceModels: string[];
  calibrationBatches: string[];
  incumbentRuleId: string;
  candidateRuleId: string;
  candidateFirmwareId: string;
  thresholds: WaveThresholds;
}

export interface RegisterFirmwareInput {
  firmwareId: string;
  digest: string;
  versionLabel: string;
}

export interface RegisterRuleInput {
  ruleId: string;
  role: "incumbent" | "candidate";
  label: string;
  payload: RulePayload;
}

export interface RegisterDeviceInput {
  deviceId: string;
  siteId: string;
  model: string;
  calibrationBatch: string;
}

export interface CheckinInput {
  deviceId: string;
  firmwareId: string;
  /** 设备侧幂等键；重复回报命中同一键，不新建记录 */
  idempotencyKey: string;
  installedAt: string;
  rollbackReason?: string;
  reportedAt: string;
}

export interface FragmentReport {
  fragmentId: string;
  idempotencyKey: string;
  seq: number;
  clientSessionId: string;
  startedAt: string;
  endedAt: string;
  readingStart: number;
  readingEnd: number;
  firmwareId: string;
  /** 采集时设备自认的固件摘要所属版本；与片段上的 firmwareId 一致时为候选 */
  reportedAt: string;
}

// ---------- 行类型 ----------

interface RuleRow {
  rule_id: string;
  role: "incumbent" | "candidate";
  label: string;
  payload_json: string;
}
interface WaveRow {
  wave_id: string;
  name: string;
  site_ids_json: string;
  device_models_json: string;
  calibration_batches_json: string;
  incumbent_rule_id: string;
  candidate_rule_id: string;
  candidate_firmware_id: string;
  thresholds_json: string;
  state: string;
}
interface DeviceRow {
  device_id: string;
  site_id: string;
  model: string;
  calibration_batch: string;
  state: string;
  current_wave_id: string | null;
}

export class GuardrailError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(s: string): T {
  return JSON.parse(s) as T;
}

function hashFragments(fragments: FragmentInput[]): string {
  const h = createHash("sha256");
  for (const f of [...fragments].sort((a, b) => a.seq - b.seq)) {
    h.update(`${f.seq}|${f.startedAt}|${f.endedAt}|${f.readingStart}|${f.readingEnd}|${f.firmwareId}|${f.isLate}\n`);
  }
  return h.digest("hex");
}

export class GrayscaleService {
  constructor(private db: DB) {}

  // ================= 基础登记 =================

  registerFirmware(input: RegisterFirmwareInput) {
    this.db
      .prepare(
        `INSERT INTO firmware_versions(firmware_id, digest, version_label, created_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(firmware_id) DO UPDATE SET digest=excluded.digest, version_label=excluded.version_label`
      )
      .run(input.firmwareId, input.digest, input.versionLabel, nowIso());
  }

  registerRule(input: RegisterRuleInput) {
    // 规则一经冻结不可变：已存在且内容不同则拒绝。
    const existing = this.db.prepare("SELECT payload_json FROM rule_versions WHERE rule_id=?").get(input.ruleId) as
      | { payload_json: string }
      | undefined;
    if (existing && existing.payload_json !== JSON.stringify(input.payload)) {
      throw new GuardrailError("RULE_FROZEN", `规则 ${input.ruleId} 已冻结，参数不可修改`);
    }
    this.db
      .prepare(
        `INSERT INTO rule_versions(rule_id, role, label, payload_json, frozen_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(rule_id) DO NOTHING`
      )
      .run(input.ruleId, input.role, input.label, JSON.stringify(input.payload), nowIso());
  }

  getRule(ruleId: string): { row: RuleRow; payload: RulePayload } {
    const row = this.db.prepare("SELECT * FROM rule_versions WHERE rule_id=?").get(ruleId) as RuleRow | undefined;
    if (!row) throw new GuardrailError("RULE_NOT_FOUND", `规则 ${ruleId} 不存在`);
    return { row, payload: parseJson<RulePayload>(row.payload_json) };
  }

  registerDevice(input: RegisterDeviceInput) {
    this.db
      .prepare(
        `INSERT INTO devices(device_id, site_id, model, calibration_batch, state, created_at)
         VALUES(?, ?, ?, ?, 'normal', ?)
         ON CONFLICT(device_id) DO NOTHING`
      )
      .run(input.deviceId, input.siteId, input.model, input.calibrationBatch, nowIso());
  }

  private getDevice(deviceId: string): DeviceRow {
    const row = this.db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId) as DeviceRow | undefined;
    if (!row) throw new GuardrailError("DEVICE_NOT_FOUND", `设备 ${deviceId} 未登记`);
    return row;
  }

  // ================= 波次与认领 =================

  createWave(input: CreateWaveInput) {
    for (const ruleId of [input.incumbentRuleId, input.candidateRuleId]) this.getRule(ruleId);
    if (!this.db.prepare("SELECT 1 FROM firmware_versions WHERE firmware_id=?").get(input.candidateFirmwareId)) {
      throw new GuardrailError("FIRMWARE_NOT_FOUND", `候选固件 ${input.candidateFirmwareId} 未登记`);
    }
    this.db
      .prepare(
        `INSERT INTO release_waves(wave_id, name, site_ids_json, device_models_json,
            calibration_batches_json, incumbent_rule_id, candidate_rule_id,
            candidate_firmware_id, thresholds_json, state, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(
        input.waveId,
        input.name,
        JSON.stringify(input.siteIds),
        JSON.stringify(input.deviceModels),
        JSON.stringify(input.calibrationBatches),
        input.incumbentRuleId,
        input.candidateRuleId,
        input.candidateFirmwareId,
        JSON.stringify(input.thresholds),
        nowIso()
      );
  }

  getWave(waveId: string): WaveRow {
    const row = this.db.prepare("SELECT * FROM release_waves WHERE wave_id=?").get(waveId) as WaveRow | undefined;
    if (!row) throw new GuardrailError("WAVE_NOT_FOUND", `波次 ${waveId} 不存在`);
    return row;
  }

  /**
   * 波次认领设备：两个波次同时认领时由 devices.current_wave_id 的条件更新保证唯一归属，
   * 并追加 wave_devices 认领历史。设备必须落在站点/型号/校准批次范围内。
   */
  claimDevice(waveId: string, deviceId: string): "claimed" | "already_claimed" {
    const wave = this.getWave(waveId);
    if (wave.state !== "active") throw new GuardrailError("WAVE_NOT_ACTIVE", `波次 ${waveId} 已${wave.state}`);
    const device = this.getDevice(deviceId);
    const sites = parseJson<string[]>(wave.site_ids_json);
    const models = parseJson<string[]>(wave.device_models_json);
    const batches = parseJson<string[]>(wave.calibration_batches_json);
    if (!sites.includes(device.site_id) || !models.includes(device.model) || !batches.includes(device.calibration_batch)) {
      throw new GuardrailError("OUT_OF_WAVE_SCOPE", `设备 ${deviceId} 不在波次 ${waveId} 的站点/型号/校准批次范围内`);
    }
    if (device.state === "isolated") throw new GuardrailError("DEVICE_ISOLATED", `设备 ${deviceId} 已隔离`);

    if (device.current_wave_id === waveId) return "already_claimed";
    if (device.current_wave_id) {
      throw new GuardrailError(
        "DEVICE_CLAIMED_BY_OTHER_WAVE",
        `设备 ${deviceId} 已归属波次 ${device.current_wave_id}，不能被 ${waveId} 重复认领`
      );
    }

    const tx = this.db.transaction(() => {
      const updated = this.db
        .prepare("UPDATE devices SET current_wave_id=? WHERE device_id=? AND current_wave_id IS NULL AND state='normal'")
        .run(waveId, deviceId);
      if (updated.changes === 0) {
        throw new GuardrailError("DEVICE_CLAIMED_BY_OTHER_WAVE", `设备 ${deviceId} 的认领发生并发冲突`);
      }
      this.db
        .prepare("INSERT INTO wave_devices(wave_id, device_id, claimed_at) VALUES(?, ?, ?)")
        .run(waveId, deviceId, nowIso());
    });
    tx();
    return "claimed";
  }

  // ================= 账期 =================

  /** 幂等开账期（按 UTC 日期）。 */
  openPeriod(day: string) {
    this.db
      .prepare(
        `INSERT INTO accounting_periods(period_id, started_at, ended_at, state)
         VALUES(?, ?, ?, 'open')
         ON CONFLICT(period_id) DO NOTHING`
      )
      .run(day, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`);
  }

  private ensurePeriodsFor(rangeFrom: string, rangeTo: string) {
    const from = new Date(periodIdOf(rangeFrom));
    const to = new Date(periodIdOf(rangeTo));
    for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
      this.openPeriod(new Date(t).toISOString().slice(0, 10));
    }
  }

  /** 片段时间范围触及的全部账期日期（含跨零点）。 */
  private daysBetween(rangeFrom: string, rangeTo: string): string[] {
    const days: string[] = [];
    const from = new Date(periodIdOf(rangeFrom));
    const to = new Date(periodIdOf(rangeTo));
    for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
  }

  /**
   * 封账：按当时已到片段、以现行规则快照落账。封账后该账期不可再被任何写入改写，
   * 迟到片段只参与灰度比较并形成调整建议。
   */
  closePeriod(day: string): void {
    const period = this.db
      .prepare("SELECT * FROM accounting_periods WHERE period_id=?")
      .get(day) as { period_id: string; state: string } | undefined;
    if (!period) throw new GuardrailError("PERIOD_NOT_FOUND", `账期 ${day} 未开立`);
    if (period.state === "closed") return;

    const tx = this.db.transaction(() => {
      const sessions = this.db
        .prepare("SELECT session_id, booked_rule_id FROM charging_sessions")
        .all() as { session_id: string; booked_rule_id: string | null }[];

      for (const s of sessions) {
        const fragments = this.fragmentsFor(s.session_id);
        if (fragments.length === 0) continue;
        const touchesDay = fragments.some(
          (f) => periodIdOf(f.startedAt) <= day && periodIdOf(f.endedAt) >= day
        );
        if (!touchesDay) continue;
        // 记账规则在会话建档时已固化（晋级绑定只作用于其后新建的会话）。
        const ruleId = s.booked_rule_id ?? this.defaultIncumbentRuleId();
        const { payload } = this.getRule(ruleId);
        const calc = calculate(fragments, payload);
        const periodCents = calc.periodAmounts[day] ?? 0;
        const count = fragments.filter((f) => periodIdOf(f.startedAt) <= day && periodIdOf(f.endedAt) >= day).length;
        this.db
          .prepare(
            `INSERT INTO session_bookings(session_id, period_id, booked_rule_id, amount_cents, fragment_count, booked_at)
             VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, period_id) DO NOTHING`
          )
          .run(s.session_id, day, ruleId, periodCents, count, nowIso());
      }

      this.db
        .prepare("UPDATE accounting_periods SET state='closed', closed_at=? WHERE period_id=? AND state='open'")
        .run(nowIso(), day);
    });
    tx();
  }

  private defaultIncumbentRuleId(): string {
    const row = this.db
      .prepare("SELECT rule_id FROM rule_versions WHERE role='incumbent' ORDER BY frozen_at ASC LIMIT 1")
      .get() as { rule_id: string } | undefined;
    if (!row) throw new GuardrailError("NO_INCUMBENT_RULE", "尚未登记现行规则，无法封账");
    return row.rule_id;
  }

  // ================= 签到与片段 =================

  /**
   * 设备签到：携带固件摘要、安装时刻、回滚缘由。幂等。
   * 候选固件签到即认领波次（若设备在范围内）；回滚到非候选固件时记录缘由，
   * 但不删除认领历史——回滚期间采用过的规则与固件仍可追溯。
   */
  checkin(input: CheckinInput): { duplicate: boolean; isCandidate: boolean } {
    const device = this.getDevice(input.deviceId);
    const fw = this.db.prepare("SELECT 1 FROM firmware_versions WHERE firmware_id=?").get(input.firmwareId);
    if (!fw) throw new GuardrailError("FIRMWARE_NOT_FOUND", `固件 ${input.firmwareId} 未登记`);

    const duplicate = this.db
      .prepare("SELECT 1 FROM device_checkins WHERE device_id=? AND idempotency_key=?")
      .get(input.deviceId, input.idempotencyKey);
    if (duplicate) return { duplicate: true, isCandidate: false };

    const wave = device.current_wave_id
      ? (this.db.prepare("SELECT * FROM release_waves WHERE wave_id=?").get(device.current_wave_id) as WaveRow)
      : null;
    const isCandidate = !!wave && input.firmwareId === wave.candidate_firmware_id;
    // 账期已封且签到上报时刻晚于封账时刻，即为迟到（只记录，不改账）。
    const closedPeriod = this.db
      .prepare("SELECT period_id FROM accounting_periods WHERE period_id=? AND state='closed' AND closed_at < ?")
      .get(periodIdOf(input.reportedAt), input.reportedAt) as { period_id: string } | undefined;

    this.db
      .prepare(
        `INSERT INTO device_checkins(checkin_id, device_id, wave_id, firmware_id, idempotency_key,
            installed_at, rollback_reason, reported_at, received_at, is_late)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.deviceId,
        device.current_wave_id,
        input.firmwareId,
        input.idempotencyKey,
        input.installedAt,
        input.rollbackReason ?? null,
        input.reportedAt,
        nowIso(),
        closedPeriod ? 1 : 0
      );

    // 回滚到旧固件：不新增认领行，只在原认领历史上留痕；波次归属与数据全部保留。
    if (wave && !isCandidate && input.rollbackReason) {
      this.db
        .prepare(
          `UPDATE wave_devices SET release_reason=?
           WHERE wave_id=? AND device_id=?`
        )
        .run(`rollback: ${input.rollbackReason}`, wave.wave_id, input.deviceId);
    }
    return { duplicate: false, isCandidate };
  }

  /** 取会话全部片段（迟到也包含），转规则引擎输入。 */
  private fragmentsFor(sessionId: string): FragmentInput[] {
    const rows = this.db
      .prepare("SELECT * FROM meter_fragments WHERE session_id=? ORDER BY seq")
      .all(sessionId) as {
      seq: number;
      started_at: string;
      ended_at: string;
      reading_start: number;
      reading_end: number;
      firmware_id: string;
      is_candidate: number;
      is_late: number;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      readingStart: r.reading_start,
      readingEnd: r.reading_end,
      firmwareId: r.firmware_id,
      isCandidate: !!r.is_candidate,
      isLate: !!r.is_late,
    }));
  }

  /**
   * 上报计量片段（可批量，同一设备一次补传）。
   * - 幂等：(device_id, idempotency_key) 重复不新建；
   * - 会话不存在则按首片自动开立，跨版本会话沿用同一 client_session_id，
   *   start_reading 保留首片表读数，绝不因固件切换清零；
   * - 片段落在已封账期：照收、打 is_late，但绝不回改封账快照；
   * - 固件切换点追加进 firmware_timeline_json。
   */
  reportFragments(deviceId: string, reports: FragmentReport[]): { accepted: number; duplicate: number; late: number } {
    const device = this.getDevice(deviceId);
    let accepted = 0;
    let duplicate = 0;
    let late = 0;

    const tx = this.db.transaction(() => {
      for (const r of [...reports].sort((a, b) => a.seq - b.seq)) {
        if (Date.parse(r.endedAt) <= Date.parse(r.startedAt)) {
          throw new GuardrailError("BAD_FRAGMENT_TIME", `片段 ${r.fragmentId} 结束时间不晚于开始时间`);
        }
        const existing = this.db
          .prepare("SELECT 1 FROM meter_fragments WHERE device_id=? AND idempotency_key=?")
          .get(deviceId, r.idempotencyKey);
        if (existing) {
          duplicate += 1;
          continue;
        }

        const wave = device.current_wave_id
          ? (this.db.prepare("SELECT * FROM release_waves WHERE wave_id=?").get(device.current_wave_id) as WaveRow)
          : null;
        const isCandidate = !!wave && r.firmwareId === wave.candidate_firmware_id;
        const day = periodIdOf(r.startedAt);
        this.ensurePeriodsFor(r.startedAt, r.endedAt);

        // 片段跨零点时，任一切及账期已封即视为迟到（照收、标记、不改账）。
        const touchedDays = this.daysBetween(r.startedAt, r.endedAt);
        const closedDays = this.db
          .prepare(
            `SELECT period_id FROM accounting_periods
             WHERE state='closed' AND period_id IN (${touchedDays.map(() => "?").join(",")})`
          )
          .all(...touchedDays) as { period_id: string }[];
        const isLate = closedDays.length > 0;
        if (isLate) late += 1;

        // 找/建会话（跨版本保持同一行）。
        let session = this.db
          .prepare("SELECT * FROM charging_sessions WHERE device_id=? AND client_session_id=?")
          .get(deviceId, r.clientSessionId) as
          | {
              session_id: string;
              start_reading: number | null;
              end_reading: number | null;
              firmware_timeline_json: string;
              period_id: string;
            }
          | undefined;

        if (!session) {
          const sessionId = randomUUID();
          // 记账规则在会话建档（首片到达）时固化：此刻已对设备生效的晋级绑定决定新规则，
          // 否则回退波次现行规则。晋级前已建档的会话不受影响，回滚后新建会话回到现行规则。
          const boundRule = this.effectiveRuleForDevice(deviceId);
          const bookingRuleId =
            boundRule ??
            (device.current_wave_id ? (this.getWave(device.current_wave_id) as WaveRow).incumbent_rule_id : this.defaultIncumbentRuleId());
          this.db
            .prepare(
              `INSERT INTO charging_sessions(session_id, device_id, wave_id, client_session_id, period_id,
                  started_at, start_reading, firmware_timeline_json, booked_rule_id, state, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, '[]', ?, 'collecting', ?)`
            )
            .run(
              sessionId,
              deviceId,
              device.current_wave_id,
              r.clientSessionId,
              day,
              r.startedAt,
              r.readingStart,
              bookingRuleId,
              nowIso()
            );
          session = {
            session_id: sessionId,
            start_reading: r.readingStart,
            end_reading: null,
            firmware_timeline_json: "[]",
            period_id: day,
          };
        }

        this.db
          .prepare(
            `INSERT INTO meter_fragments(fragment_id, session_id, device_id, idempotency_key, seq, period_id,
                started_at, ended_at, reading_start, reading_end, firmware_id, is_candidate, is_late, received_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            r.fragmentId,
            session.session_id,
            deviceId,
            r.idempotencyKey,
            r.seq,
            day,
            r.startedAt,
            r.endedAt,
            r.readingStart,
            r.readingEnd,
            r.firmwareId,
            isCandidate ? 1 : 0,
            isLate ? 1 : 0,
            nowIso()
          );

        // 表读数连续性：记录固件时间线，结束读数推进到最新片。
        const timeline = parseJson<{ at: string; firmwareId: string; reading: number }[]>(
          session.firmware_timeline_json
        );
        const last = timeline[timeline.length - 1];
        if (!last || last.firmwareId !== r.firmwareId) {
          timeline.push({ at: r.startedAt, firmwareId: r.firmwareId, reading: r.readingStart });
        }
        this.db
          .prepare("UPDATE charging_sessions SET end_reading=?, firmware_timeline_json=?, ended_at=? WHERE session_id=?")
          .run(r.readingEnd, JSON.stringify(timeline), r.endedAt, session.session_id);
        accepted += 1;
      }
    });
    tx();
    return { accepted, duplicate, late };
  }

  /** 声明会话采集完成（不封账，仅允许比较作业纳入）。 */
  completeSession(deviceId: string, clientSessionId: string) {
    const session = this.db
      .prepare("SELECT * FROM charging_sessions WHERE device_id=? AND client_session_id=?")
      .get(deviceId, clientSessionId) as { session_id: string; state: string } | undefined;
    if (!session) throw new GuardrailError("SESSION_NOT_FOUND", "会话不存在");
    this.db.prepare("UPDATE charging_sessions SET state='complete' WHERE session_id=?").run(session.session_id);
  }

  // ================= 双算比较（断点续算） =================

  /**
   * 执行（或从断点续跑）波次比较作业。
   * 已存在 wave_session_comparisons 的会话直接跳过，因此作业中断后重入只算未完成会话；
   * 每个会话独立事务提交，进程被杀也不会丢失已完成行。
   * crashAfter 仅用于测试：处理 N 个会话后把作业置为 interrupted。
   */
  runComparison(waveId: string, opts: { crashAfter?: number } = {}): {
    runId: string;
    resumed: boolean;
    processed: number;
    skipped: number;
    interrupted: boolean;
  } {
    const wave = this.getWave(waveId);

    const sessions = this.db
      .prepare("SELECT session_id FROM charging_sessions WHERE wave_id=? ORDER BY started_at, session_id")
      .all(waveId) as { session_id: string }[];

    // 待处理 = 从未比较，或片段指纹已变化（例如比较后又到了迟到片）。
    const pendingIds: string[] = [];
    for (const s of sessions) {
      const stored = this.db
        .prepare("SELECT fragments_hash FROM wave_session_comparisons WHERE wave_id=? AND session_id=?")
        .get(waveId, s.session_id) as { fragments_hash: string } | undefined;
      if (!stored || stored.fragments_hash !== hashFragments(this.fragmentsFor(s.session_id))) {
        pendingIds.push(s.session_id);
      }
    }

    const latest = this.db
      .prepare("SELECT * FROM comparison_runs WHERE wave_id=? ORDER BY started_at DESC LIMIT 1")
      .get(waveId) as { run_id: string; state: string } | undefined;

    let run: { run_id: string; state: string };
    let resumed = false;
    if (latest && latest.state !== "completed") {
      run = latest;
      resumed = true;
      this.db.prepare("UPDATE comparison_runs SET state='running', last_error=NULL WHERE run_id=?").run(run.run_id);
    } else if (latest && pendingIds.length === 0) {
      // 已完成且无新数据：幂等返回。
      return { runId: latest.run_id, resumed: true, processed: 0, skipped: sessions.length, interrupted: false };
    } else {
      const runId = randomUUID();
      this.db
        .prepare("INSERT INTO comparison_runs(run_id, wave_id, state, started_at) VALUES(?, ?, 'running', ?)")
        .run(runId, waveId, nowIso());
      run = { run_id: runId, state: "running" };
    }

    let processed = 0;
    let skipped = sessions.length - pendingIds.length;
    try {
      for (const session_id of pendingIds) {
        this.compareSession(wave, run.run_id, session_id);
        processed += 1;
        if (opts.crashAfter !== undefined && processed >= opts.crashAfter) {
          this.db
            .prepare("UPDATE comparison_runs SET state='interrupted', total_sessions=? WHERE run_id=?")
            .run(sessions.length, run.run_id);
          return { runId: run.run_id, resumed, processed, skipped, interrupted: true };
        }
      }
    } catch (err) {
      this.db
        .prepare("UPDATE comparison_runs SET state='interrupted', last_error=?, total_sessions=? WHERE run_id=?")
        .run(err instanceof Error ? err.message : String(err), sessions.length, run.run_id);
      throw err;
    }

    this.db
      .prepare("UPDATE comparison_runs SET state='completed', total_sessions=?, completed_at=? WHERE run_id=?")
      .run(sessions.length, nowIso(), run.run_id);

    this.decideDevices(wave);
    this.buildSummary(wave, run.run_id);
    return { runId: run.run_id, resumed, processed, skipped, interrupted: false };
  }

  private upsertCalculation(
    waveId: string,
    sessionId: string,
    ruleId: string,
    role: "incumbent" | "candidate",
    calc: CalcResult
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO session_calculations(calculation_id, wave_id, session_id, rule_id, rule_role,
            energy_kwh, amount_cents, negative_increments, reset_events, missing_fragments,
            expected_fragments, period_amounts_json, detail_json, computed_at)
         VALUES(@id, @waveId, @sessionId, @ruleId, @role, @energy, @amount, @neg, @reset, @missing,
            @expected, @periods, @detail, @at)
         ON CONFLICT(wave_id, session_id, rule_id) DO UPDATE SET
            energy_kwh=excluded.energy_kwh, amount_cents=excluded.amount_cents,
            negative_increments=excluded.negative_increments, reset_events=excluded.reset_events,
            missing_fragments=excluded.missing_fragments, expected_fragments=excluded.expected_fragments,
            period_amounts_json=excluded.period_amounts_json, detail_json=excluded.detail_json,
            computed_at=excluded.computed_at`
      )
      .run({
        id,
        waveId,
        sessionId,
        ruleId,
        role,
        energy: calc.energyKwh,
        amount: calc.amountCents,
        neg: calc.negativeIncrements,
        reset: calc.resetEvents,
        missing: calc.missingFragments,
        expected: calc.expectedFragments,
        periods: JSON.stringify(calc.periodAmounts),
        detail: JSON.stringify(calc.details),
        at: nowIso(),
      });
    const row = this.db
      .prepare("SELECT calculation_id FROM session_calculations WHERE wave_id=? AND session_id=? AND rule_id=?")
      .get(waveId, sessionId, ruleId) as { calculation_id: string };
    return row.calculation_id;
  }

  private compareSession(wave: WaveRow, runId: string, sessionId: string) {
    const tx = this.db.transaction(() => {
      const fragments = this.fragmentsFor(sessionId);
      if (fragments.length === 0) return;
      const incumbent = this.getRule(wave.incumbent_rule_id);
      const candidate = this.getRule(wave.candidate_rule_id);

      const calcInc = calculate(fragments, incumbent.payload);
      const calcCand = calculate(fragments, candidate.payload);
      // 仅按时到达的片段（封账前已收）以现行规则重算，用于拆分金额风险来源。
      const onTimeFragments = fragments.filter((f) => !f.isLate);
      const calcIncOnTime = calculate(onTimeFragments, incumbent.payload);

      const incCalcId = this.upsertCalculation(wave.wave_id, sessionId, wave.incumbent_rule_id, "incumbent", calcInc);
      const candCalcId = this.upsertCalculation(wave.wave_id, sessionId, wave.candidate_rule_id, "candidate", calcCand);

      const bookings = this.db
        .prepare("SELECT period_id, amount_cents, booked_rule_id FROM session_bookings WHERE session_id=?")
        .all(sessionId) as { period_id: string; amount_cents: number; booked_rule_id: string }[];
      const bookedCents = bookings.reduce((s, b) => s + b.amount_cents, 0);

      const dataGapCents = calcInc.amountCents - calcIncOnTime.amountCents;
      const ruleDeltaCents = calcCand.amountCents - calcInc.amountCents;
      // 基线 = 现行规则 × 按时片段（未封账账期也在内，因那些账期本来就按现行规则记）。
      const baselineCents = calcIncOnTime.amountCents;
      const deltaCents = calcCand.amountCents - baselineCents;

      const flags = new Set<string>();
      if (calcCand.negativeIncrements > 0) flags.add("negative_increment");
      if (calcCand.resetEvents > 0) flags.add("abnormal_reset");
      if (calcCand.missingFragments > 0) flags.add("missing_fragment");
      if (fragments.some((f) => f.isLate)) flags.add("late_fragment");
      if (Object.keys(calcInc.periodAmounts).length > 1) flags.add("crosses_midnight");
      if (ruleDeltaCents !== 0) flags.add("rule_amount_delta");
      if (fragments.some((f) => f.isCandidate) && fragments.some((f) => !f.isCandidate)) {
        flags.add("mixed_firmware_session");
      }

      const touchesClosed = bookings.length > 0 ? 1 : 0;
      const hasLate = fragments.some((f) => f.isLate) ? 1 : 0;

      this.db
        .prepare(
          `INSERT INTO wave_session_comparisons(wave_id, session_id, device_id, run_id,
              incumbent_calc_id, candidate_calc_id, incumbent_cents, candidate_cents, booked_cents,
              baseline_cents, data_gap_cents, rule_delta_cents, delta_cents, touches_closed, has_late,
              risk_flags_json, fragments_hash, compared_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(wave_id, session_id) DO UPDATE SET
              run_id=excluded.run_id, incumbent_calc_id=excluded.incumbent_calc_id,
              candidate_calc_id=excluded.candidate_calc_id, incumbent_cents=excluded.incumbent_cents,
              candidate_cents=excluded.candidate_cents, booked_cents=excluded.booked_cents,
              baseline_cents=excluded.baseline_cents,
              data_gap_cents=excluded.data_gap_cents, rule_delta_cents=excluded.rule_delta_cents,
              delta_cents=excluded.delta_cents, touches_closed=excluded.touches_closed,
              has_late=excluded.has_late, risk_flags_json=excluded.risk_flags_json,
              fragments_hash=excluded.fragments_hash, compared_at=excluded.compared_at`
        )
        .run(
          wave.wave_id,
          sessionId,
          (this.db.prepare("SELECT device_id FROM charging_sessions WHERE session_id=?").get(sessionId) as { device_id: string }).device_id,
          runId,
          incCalcId,
          candCalcId,
          calcInc.amountCents,
          calcCand.amountCents,
          bookedCents,
          baselineCents,
          dataGapCents,
          ruleDeltaCents,
          deltaCents,
          touchesClosed,
          hasLate,
          JSON.stringify([...flags]),
          hashFragments(fragments),
          nowIso()
        );

      // 已封账账期：只生成调整建议，绝不回改 session_bookings / accounting_periods。
      // 会话触及的每个已封账账期都比对一次（封账时该会话可能尚无片段，按 booked=0 处理）。
      const touchedDays = new Set<string>();
      for (const f of fragments) {
        const from = new Date(periodIdOf(f.startedAt));
        const to = new Date(periodIdOf(f.endedAt));
        for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
          touchedDays.add(new Date(t).toISOString().slice(0, 10));
        }
      }
      const closedDays = new Set(
        (
          this.db
            .prepare(
              `SELECT period_id FROM accounting_periods
               WHERE state='closed' AND period_id IN (${[...touchedDays].map(() => "?").join(",")})`
            )
            .all(...touchedDays) as { period_id: string }[]
        ).map((r) => r.period_id)
      );

      const deviceId = (this.db.prepare("SELECT device_id FROM charging_sessions WHERE session_id=?").get(sessionId) as { device_id: string }).device_id;
      for (const day of closedDays) {
        const booking = this.db
          .prepare("SELECT amount_cents, booked_rule_id FROM session_bookings WHERE session_id=? AND period_id=?")
          .get(sessionId, day) as { amount_cents: number; booked_rule_id: string } | undefined;
        const bookedAmount = booking?.amount_cents ?? 0;
        const bookedRule = booking?.booked_rule_id ?? wave.incumbent_rule_id;
        const proposedCents = calcCand.periodAmounts[day] ?? 0;
        if (proposedCents === bookedAmount) continue;
        const periodFlags: string[] = [];
        if (fragments.some((f) => f.isLate && (periodIdOf(f.startedAt) <= day && periodIdOf(f.endedAt) >= day))) {
          periodFlags.push("late_fragment");
        }
        if (ruleDeltaCents !== 0) periodFlags.push("rule_amount_delta");
        this.db
          .prepare(
            `INSERT INTO adjustment_proposals(proposal_id, wave_id, device_id, period_id, session_id,
                booked_rule_id, proposed_rule_id, booked_cents, proposed_cents, delta_cents,
                reason, state, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
             ON CONFLICT(wave_id, session_id, period_id) DO UPDATE SET
                proposed_cents=excluded.proposed_cents, delta_cents=excluded.delta_cents,
                reason=excluded.reason`
          )
          .run(
            randomUUID(),
            wave.wave_id,
            deviceId,
            day,
            sessionId,
            bookedRule,
            wave.candidate_rule_id,
            bookedAmount,
            proposedCents,
            proposedCents - bookedAmount,
            periodFlags.join("+") || "rule_amount_delta",
            nowIso()
          );
      }
    });
    tx();
  }

  /** 设备级指标与晋级/隔离裁决；超限设备立即隔离。 */
  private decideDevices(wave: WaveRow) {
    const thresholds = parseJson<WaveThresholds>(wave.thresholds_json);
    const rows = this.db
      .prepare(
        `SELECT c.device_id,
                SUM(sc_cand.negative_increments) AS neg,
                SUM(sc_cand.expected_fragments - sc_cand.missing_fragments) AS received,
                SUM(sc_cand.missing_fragments) AS missing,
                SUM(sc_cand.expected_fragments) AS expected,
                SUM(cmp.booked_cents) AS booked,
                SUM(cmp.incumbent_cents) AS incumbent,
                SUM(cmp.candidate_cents) AS candidate,
                SUM(cmp.data_gap_cents) AS data_gap,
                SUM(cmp.rule_delta_cents) AS rule_delta,
                SUM(cmp.delta_cents) AS net,
                SUM(ABS(cmp.rule_delta_cents)) AS rule_abs,
                COUNT(*) AS sessions
         FROM wave_session_comparisons cmp
         JOIN charging_sessions c ON c.session_id = cmp.session_id
         JOIN session_calculations sc_cand
           ON sc_cand.calculation_id = cmp.candidate_calc_id
         WHERE cmp.wave_id=?
         GROUP BY c.device_id`
      )
      .all(wave.wave_id) as {
      device_id: string;
      neg: number;
      received: number;
      missing: number;
      expected: number;
      booked: number;
      incumbent: number;
      candidate: number;
      data_gap: number;
      rule_delta: number;
      net: number;
      rule_abs: number;
      sessions: number;
    }[];

    for (const r of rows) {
      const reasons: string[] = [];
      const negativeRate = r.received > 0 ? r.neg / r.received : 0;
      const missingRate = r.expected > 0 ? r.missing / r.expected : 0;
      // 门槛只比较同一批片段下的新旧规则价差；迟到/缺片缺口计入账务风险但不惩罚设备。
      const denom = Math.abs(r.incumbent);
      const rel = denom > 0 ? r.rule_abs / denom : r.rule_abs > 0 ? 1 : 0;

      let decision: "promote" | "isolate" | "pending_sample" = "promote";
      if (r.sessions < thresholds.minSessions) {
        decision = "pending_sample";
        reasons.push(`样本会话不足：${r.sessions} < ${thresholds.minSessions}`);
      } else {
        if (negativeRate > thresholds.maxNegativeRate) {
          decision = "isolate";
          reasons.push(`负增量率超限：${(negativeRate * 100).toFixed(2)}% > ${(thresholds.maxNegativeRate * 100).toFixed(2)}%`);
        }
        if (missingRate > thresholds.maxMissingRate) {
          decision = "isolate";
          reasons.push(`缺片率超限：${(missingRate * 100).toFixed(2)}% > ${(thresholds.maxMissingRate * 100).toFixed(2)}%`);
        }
        if (rel > thresholds.maxAmountDiffRel) {
          decision = "isolate";
          reasons.push(`金额相对差异超限：${(rel * 100).toFixed(2)}% > ${(thresholds.maxAmountDiffRel * 100).toFixed(2)}%`);
        }
      }

      this.db
        .prepare(
          `INSERT INTO wave_device_metrics(wave_id, device_id, session_count, negative_rate, missing_rate,
              amount_diff_abs_cents, amount_net_cents, data_gap_cents, rule_delta_cents,
              amount_diff_rel, decision, reasons_json, computed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(wave_id, device_id) DO UPDATE SET
              session_count=excluded.session_count, negative_rate=excluded.negative_rate,
              missing_rate=excluded.missing_rate, amount_diff_abs_cents=excluded.amount_diff_abs_cents,
              amount_net_cents=excluded.amount_net_cents, data_gap_cents=excluded.data_gap_cents,
              rule_delta_cents=excluded.rule_delta_cents, amount_diff_rel=excluded.amount_diff_rel,
              decision=excluded.decision, reasons_json=excluded.reasons_json, computed_at=excluded.computed_at`
        )
        .run(
          wave.wave_id,
          r.device_id,
          r.sessions,
          negativeRate,
          missingRate,
          r.rule_abs,
          r.net,
          r.data_gap,
          r.rule_delta,
          rel,
          decision,
          JSON.stringify(reasons),
          nowIso()
        );

      if (decision === "isolate") {
        this.db
          .prepare(
            `UPDATE devices SET state='isolated', isolated_reason=?, isolated_at=?
             WHERE device_id=? AND state='normal'`
          )
          .run(reasons.join("；"), nowIso(), r.device_id);
      }
    }
  }

  // ================= 审批、晋级与回滚 =================

  /** 计量 / 清算负责人分别确认。第二张批准签到位时触发晋级绑定。 */
  approve(waveId: string, role: "metering" | "clearing", approver: string, decision: "approve" | "reject"): {
    promoted: boolean;
  } {
    const wave = this.getWave(waveId);
    if (wave.state !== "active") throw new GuardrailError("WAVE_NOT_ACTIVE", `波次 ${waveId} 当前状态 ${wave.state}，不可审批`);
    const summary = this.db.prepare("SELECT 1 FROM wave_summaries WHERE wave_id=?").get(waveId);
    if (!summary) throw new GuardrailError("NO_COMPARISON_YET", "比较作业尚未完成，无守恒汇总可审");

    this.db
      .prepare(
        `INSERT INTO wave_approvals(wave_id, role, approver, decision, approved_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(wave_id, role) DO UPDATE SET approver=excluded.approver, decision=excluded.decision, approved_at=excluded.approved_at`
      )
      .run(waveId, role, approver, decision, nowIso());

    if (decision === "reject") return { promoted: false };

    const approvals = this.db
      .prepare("SELECT decision FROM wave_approvals WHERE wave_id=?")
      .all(waveId) as { decision: string }[];
    const bothApproved = approvals.length === 2 && approvals.every((a) => a.decision === "approve");
    if (!bothApproved) return { promoted: false };

    // 双签齐备：新规则只对裁决为 promote 的设备的“后续会话”生效；隔离设备不绑定。
    const tx = this.db.transaction(() => {
      const promoted = this.db
        .prepare(
          `SELECT m.device_id FROM wave_device_metrics m
           JOIN devices d ON d.device_id = m.device_id
           WHERE m.wave_id=? AND m.decision='promote' AND d.state='normal'`
        )
        .all(waveId) as { device_id: string }[];
      for (const d of promoted) {
        this.db
          .prepare(
            `INSERT INTO rule_bindings(binding_id, wave_id, device_id, rule_id, firmware_id,
                state, effective_at)
             VALUES(?, ?, ?, ?, ?, 'effective', ?)`
          )
          .run(randomUUID(), waveId, d.device_id, wave.candidate_rule_id, wave.candidate_firmware_id, nowIso());
      }
      this.db
        .prepare("UPDATE release_waves SET state='promoted', decided_at=? WHERE wave_id=?")
        .run(nowIso(), waveId);
    });
    tx();
    return { promoted: true };
  }

  /**
   * 回滚：撤销规则绑定（行永久保留，含生效区间），波次置 rolled_back；
   * 期间产生的会话、双算结果、采用过的规则与固件全部保留可溯。
   */
  rollback(waveId: string, reason: string) {
    const wave = this.getWave(waveId);
    if (wave.state === "rolled_back") return;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE rule_bindings SET state='revoked', revoked_at=?, revoke_reason=?
           WHERE wave_id=? AND state='effective'`
        )
        .run(nowIso(), reason, waveId);
      this.db
        .prepare(
          `UPDATE wave_devices SET released_at=?, release_reason=?
           WHERE wave_id=? AND released_at IS NULL`
        )
        .run(nowIso(), `rollback: ${reason}`, waveId);
      this.db
        .prepare("UPDATE release_waves SET state='rolled_back', decided_at=? WHERE wave_id=?")
        .run(nowIso(), waveId);
    });
    tx();
  }

  /** 设备在指定时刻生效的规则绑定（晋级后的后续会话据此记账）；无绑定则回退现行规则。 */
  effectiveRuleForDevice(deviceId: string, atIso = nowIso()): string | null {
    const binding = this.db
      .prepare(
        `SELECT rule_id, effective_at, revoked_at FROM rule_bindings
         WHERE device_id=? AND state='effective' AND effective_at <= ?
         ORDER BY effective_at DESC LIMIT 1`
      )
      .get(deviceId, atIso) as { rule_id: string } | undefined;
    return binding?.rule_id ?? null;
  }

  // ================= 守恒汇总 =================

  private buildSummary(wave: WaveRow, runId: string) {
    const cmp = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(incumbent_cents),0) AS inc,
                COALESCE(SUM(candidate_cents),0) AS cand,
                COALESCE(SUM(booked_cents),0) AS booked,
                COALESCE(SUM(baseline_cents),0) AS baseline,
                COALESCE(SUM(data_gap_cents),0) AS gap,
                COALESCE(SUM(rule_delta_cents),0) AS rule_delta,
                COALESCE(SUM(delta_cents),0) AS delta
         FROM wave_session_comparisons WHERE wave_id=?`
      )
      .get(wave.wave_id) as {
      n: number;
      inc: number;
      cand: number;
      booked: number;
      baseline: number;
      gap: number;
      rule_delta: number;
      delta: number;
    };

    const dev = this.db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            SUM(decision='promote') AS promote_n,
            SUM(decision='isolate') AS isolate_n,
            SUM(decision='pending_sample') AS pending_n,
            COALESCE(SUM(amount_net_cents),0) AS device_net,
            COALESCE(SUM(amount_diff_abs_cents),0) AS device_abs
         FROM wave_device_metrics WHERE wave_id=?`
      )
      .get(wave.wave_id) as {
      total: number;
      promote_n: number;
      isolate_n: number;
      pending_n: number;
      device_net: number;
      device_abs: number;
    };

    // 守恒：① 会话差之和 = 设备净差之和；
    //       ② 总净差 = 候选总额 − 基线总额（现行规则 × 按时片段）；
    //       ③ 总净差 = 规则价差 + 迟到/缺片数据缺口（金额风险来源可分解）。
    const conservationOk =
      cmp.delta === dev.device_net &&
      cmp.cand - cmp.baseline === cmp.delta &&
      cmp.rule_delta + cmp.gap === cmp.delta
        ? 1
        : 0;

    const hashRows = this.db
      .prepare(
        `SELECT cmp.session_id, cmp.fragments_hash, cmp.incumbent_cents, cmp.candidate_cents,
                cmp.data_gap_cents, cmp.rule_delta_cents
         FROM wave_session_comparisons cmp WHERE cmp.wave_id=?
         ORDER BY cmp.session_id`
      )
      .all(wave.wave_id) as Record<string, string | number>[];
    const h = createHash("sha256");
    for (const row of hashRows) h.update(JSON.stringify(row) + "\n");
    const sessionsHash = h.digest("hex");

    this.db
      .prepare(
        `INSERT INTO wave_summaries(summary_id, wave_id, run_id, devices_total, devices_promote,
            devices_isolate, devices_pending, sessions_compared, incumbent_cents_total,
            candidate_cents_total, booked_cents_total, baseline_cents_total, delta_cents_total,
            conservation_ok, sessions_hash, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wave_id) DO UPDATE SET
            run_id=excluded.run_id, devices_total=excluded.devices_total,
            devices_promote=excluded.devices_promote, devices_isolate=excluded.devices_isolate,
            devices_pending=excluded.devices_pending, sessions_compared=excluded.sessions_compared,
            incumbent_cents_total=excluded.incumbent_cents_total,
            candidate_cents_total=excluded.candidate_cents_total,
            booked_cents_total=excluded.booked_cents_total,
            baseline_cents_total=excluded.baseline_cents_total,
            delta_cents_total=excluded.delta_cents_total, conservation_ok=excluded.conservation_ok,
            sessions_hash=excluded.sessions_hash, created_at=excluded.created_at`
      )
      .run(
        randomUUID(),
        wave.wave_id,
        runId,
        dev.total,
        dev.promote_n ?? 0,
        dev.isolate_n ?? 0,
        dev.pending_n ?? 0,
        cmp.n,
        cmp.inc,
        cmp.cand,
        cmp.booked,
        cmp.baseline,
        cmp.delta,
        conservationOk,
        sessionsHash,
        nowIso()
      );

    if (!conservationOk) {
      throw new GuardrailError("CONSERVATION_MISMATCH", `波次 ${wave.wave_id} 汇总守恒校验失败，已阻止出报告`);
    }
    void dev.device_abs;
  }
}
