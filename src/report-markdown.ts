import type { WaveReport } from "./reporting.js";

function yuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}¥${(abs / 100).toFixed(2)}`;
}

function pct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

const DECISION_LABEL: Record<string, string> = {
  promote: "✅ 可晋级",
  quarantine: "⛔ 必须隔离",
  blocked: "⏸ 样本不足暂缓",
  pending: "⏳ 未裁决",
  observe: "👀 观察",
};

export function renderWaveReport(r: WaveReport): string {
  const lines: string[] = [];
  lines.push(`# 计量固件灰度报告 — 波次 ${r.waveId}`);
  lines.push("");
  lines.push(`生成时间：${r.generatedAt}　波次状态：${r.status}`);
  lines.push("");

  // —— 结论 ——
  lines.push("## 一、晋级结论（TL;DR）");
  lines.push("");
  lines.push(`- 设备总数 **${r.totals.devices}**：可晋级 **${r.totals.promote}**，必须隔离 **${r.totals.quarantine}**，样本不足暂缓 **${r.totals.blocked}**。`);
  lines.push(`- 双规则金额：现行 ${yuan(r.totals.currentCents)} → 候选 ${yuan(r.totals.candidateCents)}，净差异 **${yuan(r.totals.deltaCents)}**。`);
  lines.push(`- 比较完成会话：${r.sessionsCompared} 个；规则：现行 \`${r.rules.current}\` vs 候选 \`${r.rules.candidate}\`（两份定义均冻结）。`);
  const allChecksPassed = r.checks.every((c) => c.passed);
  lines.push(`- 守恒校验：**${allChecksPassed ? "全部通过" : "存在失败项，禁止放行"}**（见第六节）。`);
  const approvalText = (role: string, label: string): string => {
    const a = r.approvals.find((x) => x.role === role);
    if (!a) return `${label}：未签`;
    return `${label}：${a.decision === "approved" ? "✅" : "❌"} ${a.approver}`;
  };
  lines.push(`- 双签放行：${approvalText("metering_lead", "计量负责人")}；${approvalText("clearing_lead", "清算负责人")}。未双签候选规则不得作用于后续会话。`);
  if (r.status === "rolled_back") {
    lines.push("- 波次已**回滚**：后续会话回落现行规则；回滚期间已按候选规则入账的结算行与规则版本原样保留。");
  }
  lines.push("");

  // —— 范围 ——
  lines.push("## 二、波次范围与门槛");
  lines.push("");
  lines.push(`- 站点：${r.scope.sites.join("、") || "（无）"}`);
  lines.push(`- 设备型号：${r.scope.models.join("、") || "（无）"}`);
  lines.push(`- 校准批次：${r.scope.batches.join("、") || "（无）"}`);
  const t = r.thresholds;
  lines.push("");
  lines.push("| 门槛项 | 限值 |");
  lines.push("|---|---|");
  lines.push(`| 负增量会话占比 | ≤ ${pct(t.maxNegativeRate, 1)} |`);
  lines.push(`| 缺片率（缺失 seq/应有 seq） | ≤ ${pct(t.maxMissingRate, 1)} |`);
  lines.push(`| 最少完整会话样本 | ≥ ${t.minSamples} |`);
  lines.push(`| 金额差异率 | ≤ ${pct(t.maxAmountDeltaRate)} |`);
  lines.push(`| 金额差异绝对值 | ≤ ${yuan(t.maxAmountDeltaCents)} |`);
  lines.push("");

  // —— 设备清单 ——
  lines.push("## 三、设备裁决清单");
  lines.push("");
  lines.push("| 设备 | 站点 | 型号 | 校准批次 | 固件(摘要前12) | 样本 | 负增量占比 | 缺片率 | 现行金额 | 候选金额 | 差异 | 裁决 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sorted = [...r.devices].sort((a, b) => {
    const order: Record<string, number> = { quarantine: 0, blocked: 1, promote: 2, pending: 3 };
    return (order[a.decision] ?? 9) - (order[b.decision] ?? 9);
  });
  for (const d of sorted) {
    const m = d.metrics as {
      samples?: number; negativeRate?: number; maxMissingRate?: number;
      currentCents?: number; candidateCents?: number; deltaCents?: number;
    };
    lines.push([
      `\`${d.deviceId}\``, d.siteId, d.model, d.calibrationBatch,
      `\`${d.firmwareDigest.slice(0, 12)}\``,
      m.samples ?? "—",
      m.negativeRate !== undefined ? pct(m.negativeRate, 1) : "—",
      m.maxMissingRate !== undefined ? pct(m.maxMissingRate, 1) : "—",
      m.currentCents !== undefined ? yuan(m.currentCents) : "—",
      m.candidateCents !== undefined ? yuan(m.candidateCents) : "—",
      m.deltaCents !== undefined ? yuan(m.deltaCents) : "—",
      DECISION_LABEL[d.decision] ?? d.decision,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  const quarantined = r.devices.filter((d) => d.decision === "quarantine");
  const blocked = r.devices.filter((d) => d.decision === "blocked");
  if (quarantined.length || blocked.length) {
    lines.push("### 隔离/暂缓原因");
    lines.push("");
    for (const d of [...quarantined, ...blocked]) {
      lines.push(`- \`${d.deviceId}\`（${DECISION_LABEL[d.decision]}）：${d.reasons.join("；") || "—"}`);
    }
    lines.push("");
  }

  // —— 金额风险来自哪里 ——
  lines.push("## 四、金额风险归因");
  lines.push("");
  lines.push("候选规则相对现行的净差异被严格分解为三项，三项之和恒等于总差异：");
  lines.push("");
  lines.push("| 风险分量 | 金额 | 含义 |");
  lines.push("|---|---:|---|");
  lines.push(`| 跨零点切段迁移 | ${yuan(r.riskByComponent.midnightTransferCents)} | 仅把金额在相邻账期间迁移，波次净额≈0（残差为整数分四舍五入） |`);
  lines.push(`| 异常复位找回 | ${yuan(r.riskByComponent.resetCents)} | 新固件声明表计复位后，候选规则保留复位后能量；旧规整片丢弃 |`);
  lines.push(`| 峰谷价差(TOU) | ${yuan(r.riskByComponent.priceCents)} | 同一能量按峰/平/谷计价与旧规平价之差 |`);
  lines.push(`| **合计** | **${yuan(r.riskByComponent.midnightTransferCents + r.riskByComponent.resetCents + r.riskByComponent.priceCents)}** | 应等于净差异 ${yuan(r.totals.deltaCents)} |`);
  lines.push("");
  lines.push("### 分账期影响");
  lines.push("");
  lines.push("| 账期(站点本地日) | 现行 | 候选 | 差异 |");
  lines.push("|---|---:|---:|---:|");
  for (const p of r.riskByPeriod) {
    lines.push(`| ${p.date} | ${yuan(p.currentCents)} | ${yuan(p.candidateCents)} | ${yuan(p.deltaCents)} |`);
  }
  lines.push("");

  // —— 作业与不变量 ——
  lines.push("## 五、作业与数据纪律");
  lines.push("");
  lines.push("- 比较作业以会话为最小事务单元，中断后从已完成会话续算，不重复计费。");
  lines.push("- 设备签到携带固件摘要、安装时刻与回滚缘由；重复回报不新建记录（唯一约束兜底）。");
  lines.push("- 同一会话跨固件版本：表读数原样保留，按片关联当时固件。");
  lines.push("- 离线补传可以迟到，但不得改写已封账账期；迟到数据只生成调整建议。");
  lines.push("- 两个波次同时认领同一设备被唯一 active 认领索引拒绝。");
  lines.push("- 回滚不删除已按候选规则入账的记录，其间采用过的规则版本在结算行中保留。");
  lines.push("");

  // —— 守恒 ——
  lines.push("## 六、守恒校验");
  lines.push("");
  for (const c of r.checks) {
    lines.push(`- ${c.passed ? "✅" : "❌"} **${c.name}**：${c.detail}`);
  }
  lines.push("");

  // —— 反查 ——
  lines.push("## 七、差异反查方法");
  lines.push("");
  lines.push("日结人员可从任意一笔差异反查完整证据链（接口 `GET /waves/:waveId/trace/:sessionId`）：");
  lines.push("");
  lines.push("固件版本/摘要/回滚缘由 → 冻结的现行/候选规则定义 → 每片读数区间与复位声明 →");
  lines.push("金额三分量与分账期结果 → 比较作业版本(input_hash/run_id) → 双签审批版本 → 已生效结算行。");
  lines.push("");
  return lines.join("\n");
}
