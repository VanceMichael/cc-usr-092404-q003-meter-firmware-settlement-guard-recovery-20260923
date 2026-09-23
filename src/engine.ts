import { createHash } from "node:crypto";
import { epoch, localDate, localHour, localMidnightUtc } from "./time.js";
import type { CandidateRule, CurrentRule, MeteringRule } from "./rules.js";

export interface EngineSegment {
  seq: number;
  start_reading_mwh: number;
  end_reading_mwh: number;
  started_at: string;
  ended_at: string;
  reset_after_previous: boolean;
}

export interface DroppedSlice {
  seq: number;
  reason: "slice_negative" | "undeclared_regression";
}

export interface RuleResult {
  totalCents: number;
  perPeriod: Record<string, number>; // 本地日期 -> 分
  droppedSlices: DroppedSlice[];
  negativeCount: number; // 原始表观察到的负增量片数（两规共用的硬件异常信号）
  resetCount: number;    // 固件声明的复位次数
  acceptedMwh: number;   // 接受计账的能量（毫瓦时）
}

export interface DeltaComponents {
  // 各分量均为 candidate 相对 current 的增量，按账期日期分解
  midnightTransfer: Record<string, number>; // 跨零点归属迁移（合计≈0，仅含四舍五入扰动）
  reset: Record<string, number>;            // v2 凭复位声明找回的能量
  price: Record<string, number>;            // TOU 与平价之差
}

export interface ComparisonOutcome {
  current: RuleResult;
  candidate: RuleResult;
  deltaCents: number;
  components: DeltaComponents;
  missingRate: number; // 缺片率：缺失 seq 数 / 应有 seq 数
  inputHash: string;
}

/** 四舍五入到整数分（金额一律整数）。 */
function roundCents(mwh: number, centsPerKwh: number): number {
  return Math.floor((mwh * centsPerKwh) / 1_000_000 + 0.5);
}

type Ledger = Record<string, number>;

function addCents(ledger: Ledger, date: string, cents: number): void {
  ledger[date] = (ledger[date] ?? 0) + cents;
}

function mergeLedger(a: Ledger, b: Ledger, sign: 1 | -1): Ledger {
  const out: Ledger = { ...a };
  for (const [date, cents] of Object.entries(b)) out[date] = (out[date] ?? 0) + sign * cents;
  return out;
}

function total(ledger: Ledger): number {
  return Object.values(ledger).reduce((s, v) => s + v, 0);
}

/** 本地小时边界切分（小时边界自然包含零点）。 */
function hourBoundaries(t0: number, t1: number, offsetMin: number): Array<[number, number]> {
  const chunks: Array<[number, number]> = [];
  let cursor = t0;
  while (cursor < t1) {
    const shifted = cursor + offsetMin * 60_000;
    const nextHour = Math.floor(shifted / 3_600_000 + 1) * 3_600_000 - offsetMin * 60_000;
    const end = Math.min(nextHour, t1);
    chunks.push([cursor, end]);
    cursor = end;
  }
  return chunks;
}

/** 仅在本地零点切分。 */
function midnightBoundaries(t0: number, t1: number, offsetMin: number): Array<[number, number]> {
  const chunks: Array<[number, number]> = [];
  let cursor = t0;
  while (cursor < t1) {
    const day = localDate(cursor, offsetMin);
    const nextMidnight = localMidnightUtc(day, offsetMin) + 86_400_000;
    const end = Math.min(nextMidnight, t1);
    chunks.push([cursor, end]);
    cursor = end;
  }
  return chunks;
}

interface AcceptedSlice {
  seq: number;
  mwh: number; // 计账能量（毫瓦时）
  t0: number;
  t1: number;
  reset: boolean;
}

interface Prepared {
  acceptedV1: AcceptedSlice[]; // 现行规则保留（未声明复位的正常片）
  acceptedV2: AcceptedSlice[]; // 候选规则保留（含声明复位片）
  dropped: DroppedSlice[];
  negativeCount: number;
  resetCount: number;
  sessionStart: number;
}

function prepare(segments: EngineSegment[]): Prepared {
  const segs = [...segments].sort((a, b) => a.seq - b.seq);
  const acceptedV1: AcceptedSlice[] = [];
  const acceptedV2: AcceptedSlice[] = [];
  const dropped: DroppedSlice[] = [];
  let negativeCount = 0;
  let resetCount = 0;
  let prevEnd: number | null = null;
  let sessionStart = Infinity;

  for (const s of segs) {
    const t0 = epoch(s.started_at);
    const t1 = epoch(s.ended_at);
    if (t1 <= t0) throw new Error(`片段 ${s.seq} 时间区间非法`);
    sessionStart = Math.min(sessionStart, t0);
    const inc = s.end_reading_mwh - s.start_reading_mwh;
    const undeclaredRegression = prevEnd !== null && !s.reset_after_previous && s.end_reading_mwh < prevEnd;
    if (inc < 0) negativeCount += 1;
    if (s.reset_after_previous) resetCount += 1;

    const slice: AcceptedSlice = { seq: s.seq, mwh: inc, t0, t1, reset: s.reset_after_previous };
    if (inc < 0 || undeclaredRegression) {
      dropped.push({ seq: s.seq, reason: inc < 0 ? "slice_negative" : "undeclared_regression" });
    } else {
      acceptedV2.push(slice);
      // v1 不信任复位声明：只要末读数低于上一片末读数就整片丢弃
      const v1Regression = prevEnd !== null && s.end_reading_mwh < prevEnd;
      if (!v1Regression) acceptedV1.push(slice);
    }
    prevEnd = s.end_reading_mwh;
  }
  if (!Number.isFinite(sessionStart)) throw new Error("没有可用片段");
  return { acceptedV1, acceptedV2, dropped, negativeCount, resetCount, sessionStart };
}

function billV1(slices: AcceptedSlice[], rule: CurrentRule, sessionStart: number): Ledger {
  const date = localDate(sessionStart);
  const ledger: Ledger = {};
  for (const s of slices) addCents(ledger, date, roundCents(s.mwh, rule.flat_cents_per_kwh));
  return ledger;
}

function billMidnightFlat(slices: AcceptedSlice[], rate: number, offsetMin: number): Ledger {
  const ledger: Ledger = {};
  for (const s of slices) {
    for (const [c0, c1] of midnightBoundaries(s.t0, s.t1, offsetMin)) {
      const part = s.mwh * ((c1 - c0) / (s.t1 - s.t0));
      addCents(ledger, localDate(c0, offsetMin), roundCents(part, rate));
    }
  }
  return ledger;
}

function billV2(slices: AcceptedSlice[], rule: CandidateRule, offsetMin: number): Ledger {
  const ledger: Ledger = {};
  for (const s of slices) {
    for (const [c0, c1] of hourBoundaries(s.t0, s.t1, offsetMin)) {
      const part = s.mwh * ((c1 - c0) / (s.t1 - s.t0));
      const rate = rule.tou_bands.find((b) => b.hours.includes(localHour(c0, offsetMin)))?.cents_per_kwh
        ?? rule.default_cents_per_kwh;
      addCents(ledger, localDate(c0, offsetMin), roundCents(part, rate));
    }
  }
  return ledger;
}

function finalize(ledger: Ledger, prep: Prepared, accepted: AcceptedSlice[]): RuleResult {
  return {
    totalCents: total(ledger),
    perPeriod: ledger,
    droppedSlices: prep.dropped,
    negativeCount: prep.negativeCount,
    resetCount: prep.resetCount,
    acceptedMwh: accepted.reduce((sum, s) => sum + s.mwh, 0),
  };
}

function computeMissingRate(segments: EngineSegment[]): number {
  const seqs = segments.map((s) => s.seq).sort((a, b) => a - b);
  if (seqs.length === 0) return 0;
  const expected = seqs[seqs.length - 1] - seqs[0] + 1;
  const present = new Set(seqs).size;
  return (expected - present) / expected;
}

export function compareRules(
  segments: EngineSegment[],
  current: CurrentRule,
  candidate: CandidateRule,
  offsetMin: number,
): ComparisonOutcome {
  if (segments.length === 0) throw new Error("会话没有片段");
  const prep = prepare(segments);

  // L0：现行规则实账 —— 平价、整片归会话起始日、复位片丢弃
  const l0 = billV1(prep.acceptedV1, current, prep.sessionStart);
  // L1：现行取舍，但跨零点切段、仍平价 —— 与 L0 之差即跨零点归属迁移
  const l1 = billMidnightFlat(prep.acceptedV1, current.flat_cents_per_kwh, offsetMin);
  // L2：候选取舍（找回声明复位能量），跨零点、平价 —— 增量即复位分量
  const l2 = billMidnightFlat(prep.acceptedV2, current.flat_cents_per_kwh, offsetMin);
  // L3：候选规则实账 —— 跨零点切段 + TOU
  const l3 = billV2(prep.acceptedV2, candidate, offsetMin);

  const midnightTransfer = mergeLedger(l1, l0, -1);
  const reset = mergeLedger(l2, l1, -1);
  const price = mergeLedger(l3, l2, -1);
  const deltaCents = total(l3) - total(l0);

  const canonical = JSON.stringify({
    segments: [...segments].sort((a, b) => a.seq - b.seq),
    rules: [current.rule_version, candidate.rule_version],
  });
  const inputHash = createHash("sha256").update(canonical).digest("hex");

  return {
    current: finalize(l0, prep, prep.acceptedV1),
    candidate: finalize(l3, prep, prep.acceptedV2),
    deltaCents,
    components: { midnightTransfer, reset, price },
    missingRate: computeMissingRate(segments),
    inputHash,
  };
}

/** 单独按一条规则出账（回滚保留等场景复用）。 */
export function billWithRule(
  segments: EngineSegment[],
  rule: MeteringRule,
  offsetMin: number,
): RuleResult {
  const prep = prepare(segments);
  if (rule.family === "current") {
    return finalize(billV1(prep.acceptedV1, rule, prep.sessionStart), prep, prep.acceptedV1);
  }
  return finalize(billV2(prep.acceptedV2, rule, offsetMin), prep, prep.acceptedV2);
}
