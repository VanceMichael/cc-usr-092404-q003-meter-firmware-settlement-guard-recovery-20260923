// 冻结计量/计价规则的解释器。规则以 JSON 固化在 rule_versions.payload_json，
// 本文件只解释，不内置任何“新旧固件区别对待”：同一批片段可分别喂给现行与候选规则。

export interface RulePayload {
  /** 每千瓦时单价（分） */
  priceCentsPerKwh: number;
  /** 金额舍入方式 */
  roundingMode: "round" | "floor" | "ceil";
  /**
   * 异常复位（绝对表读数大幅回落）处理：
   * - passthrough：负增量原样计入（旧固件行为，偏差直接进账）
   * - clamp_zero ：负增量归零，只计数
   * - wrap       ：按满量程 rolloverKwh 绕回，视为继续累计
   */
  resetPolicy: "passthrough" | "clamp_zero" | "wrap";
  /** wrap 策略下的满量程千瓦时 */
  rolloverKwh?: number;
  /** 回落绝对值超过该阈值（千瓦时）记为异常复位事件，否则记普通负增量 */
  resetToleranceKwh: number;
}

export interface FragmentInput {
  seq: number;
  startedAt: string;
  endedAt: string;
  readingStart: number;
  readingEnd: number;
  firmwareId: string;
  isCandidate: boolean;
  isLate: boolean;
}

export interface FragmentDetail {
  seq: number;
  firmwareId: string;
  rawDelta: number;
  energyKwh: number;
  classified: "normal" | "negative" | "reset_wrap" | "reset_clamped" | "reset_passthrough";
  split?: Record<string, number>;
}

export interface CalcResult {
  energyKwh: number;
  amountCents: number;
  negativeIncrements: number;
  resetEvents: number;
  missingFragments: number;
  expectedFragments: number;
  /** 账期日期 -> 该账期能量（千瓦时），跨零点片段按时间比例分摊 */
  periodEnergy: Record<string, number>;
  /** 账期日期 -> 该账期金额（分），逐账期舍入后求和 */
  periodAmounts: Record<string, number>;
  details: FragmentDetail[];
}

export function periodIdOf(iso: string): string {
  return iso.slice(0, 10); // 以 UTC 零点切账期，确定性可复算
}

function roundCents(value: number, mode: RulePayload["roundingMode"]): number {
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  return Math.round(value);
}

/** 跨零点片段按落在各账期内的时长比例分摊能量。 */
function splitAcrossMidnights(
  startedAt: string,
  endedAt: string,
  energyKwh: number
): Record<string, number> {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const total = Math.max(end - start, 1);
  const shares: Record<string, number> = {};
  let cursor = new Date(start);
  let remaining = energyKwh;
  while (cursor.getTime() < end) {
    const day = periodIdOf(cursor.toISOString());
    const nextMidnight = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1);
    const sliceEnd = Math.min(nextMidnight, end);
    const share = energyKwh * ((sliceEnd - cursor.getTime()) / total);
    shares[day] = (shares[day] ?? 0) + share;
    remaining -= share;
    cursor = new Date(sliceEnd);
  }
  // 消除浮点尾巴：并入最后一个账期。
  const days = Object.keys(shares).sort();
  if (days.length > 0 && Math.abs(remaining) > 0) shares[days[days.length - 1]] += remaining;
  return shares;
}

export function calculate(fragments: FragmentInput[], rule: RulePayload): CalcResult {
  const ordered = [...fragments].sort((a, b) => a.seq - b.seq);

  let energyKwh = 0;
  let negativeIncrements = 0;
  let resetEvents = 0;
  const periodEnergy: Record<string, number> = {};
  const details: FragmentDetail[] = [];

  for (const f of ordered) {
    const rawDelta = f.readingEnd - f.readingStart;
    let delta = rawDelta;
    let classified: FragmentDetail["classified"] = "normal";

    if (rawDelta < 0) {
      negativeIncrements += 1;
      const isReset = rawDelta <= -rule.resetToleranceKwh;
      if (isReset) resetEvents += 1;

      if (rule.resetPolicy === "passthrough") {
        // 现行旧规则：负增量原样计入，偏差会直接写进账单。
        delta = rawDelta;
        classified = isReset ? "reset_passthrough" : "negative";
      } else if (rule.resetPolicy === "wrap" && isReset && rule.rolloverKwh) {
        // 表具满量程绕回：绕回后继续累计。
        const wrapped = f.readingEnd + rule.rolloverKwh - f.readingStart;
        delta = wrapped >= 0 ? wrapped : 0;
        classified = "reset_wrap";
      } else {
        // clamp_zero：复位（或 wrap 下的小幅抖动）一律归零，只保留计数。
        delta = 0;
        classified = isReset ? "reset_clamped" : "negative";
      }
    }

    energyKwh += delta;
    const split = splitAcrossMidnights(f.startedAt, f.endedAt, delta);
    for (const [day, share] of Object.entries(split)) {
      periodEnergy[day] = (periodEnergy[day] ?? 0) + share;
    }
    details.push({
      seq: f.seq,
      firmwareId: f.firmwareId,
      rawDelta,
      energyKwh: delta,
      classified,
      split,
    });
  }

  // 缺片：序号自 1 起连续，期望数 = 最大序号；缺失 = 期望 - 实收。
  const expectedFragments = ordered.length ? Math.max(...ordered.map((f) => f.seq)) : 0;
  const missingFragments = Math.max(0, expectedFragments - ordered.length);

  const periodAmounts: Record<string, number> = {};
  let amountCents = 0;
  for (const [day, energy] of Object.entries(periodEnergy)) {
    const cents = roundCents(energy * rule.priceCentsPerKwh, rule.roundingMode);
    periodAmounts[day] = cents;
    amountCents += cents;
  }

  return {
    energyKwh,
    amountCents,
    negativeIncrements,
    resetEvents,
    missingFragments,
    expectedFragments,
    periodEnergy,
    periodAmounts,
    details,
  };
}
