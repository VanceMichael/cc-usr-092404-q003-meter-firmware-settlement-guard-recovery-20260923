// 冻结规则定义。规则只追加、永不就地修改；晋级后若再改规则必须发新版本。
export interface CurrentRule {
  rule_version: string;
  family: "current";
  flat_cents_per_kwh: number;
  attribution: "session_start"; // 整个会话金额计入会话开始当日
  on_regression: "drop_slice";  // 读数相对上一片回退：丢弃该片
  on_negative: "drop_slice";    // 片内负增量：丢弃该片
  created_at: string;
}

export interface TouBand {
  hours: number[]; // 本地小时 [h, h+1)
  cents_per_kwh: number;
}

export interface CandidateRule {
  rule_version: string;
  family: "candidate";
  split_at_midnight: true;
  tou_bands: TouBand[];
  default_cents_per_kwh: number;
  on_declared_reset: "retain"; // 固件声明复位：保留复位后读数增量
  on_undeclared_regression: "drop_slice";
  created_at: string;
}

export type MeteringRule = CurrentRule | CandidateRule;

export function currentRuleV1(now: string): CurrentRule {
  return {
    rule_version: "metering-v1",
    family: "current",
    flat_cents_per_kwh: 100, // 1.00 元/kWh
    attribution: "session_start",
    on_regression: "drop_slice",
    on_negative: "drop_slice",
    created_at: now,
  };
}

export function candidateRuleV2(now: string): CandidateRule {
  return {
    rule_version: "metering-v2",
    family: "candidate",
    split_at_midnight: true,
    // 站点本地 TOU：谷 00-06 0.30 元；峰 09-12/18-21 1.50 元；其余（含 22-24）平 1.00 元
    tou_bands: [
      { hours: [0, 1, 2, 3, 4, 5], cents_per_kwh: 30 },
      { hours: [9, 10, 11, 18, 19, 20], cents_per_kwh: 150 },
    ],
    default_cents_per_kwh: 100,
    on_declared_reset: "retain",
    on_undeclared_regression: "drop_slice",
    created_at: now,
  };
}

export function touRateForHour(rule: CandidateRule, hour: number): number {
  return rule.tou_bands.find((b) => b.hours.includes(hour))?.cents_per_kwh ?? rule.default_cents_per_kwh;
}
