import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMigratedDatabase } from "../src/db.js";
import { CanaryService } from "../src/service.js";
import { Adjudication, ComparisonJob, generateLateAdvices } from "../src/jobs.js";
import { Reporting } from "../src/reporting.js";
import { renderWaveReport } from "../src/report-markdown.js";
import { candidateRuleV2, currentRuleV1 } from "../src/rules.js";

// 确定性演示：业务时间全部写死；服务时钟用可推进的模拟时钟，保证“晋级时刻 < 晋级后会话”。
const T0 = "2026-09-20T00:00:00.000Z";
const WAVE = "W-2026-09-22";
const SITES = ["S-HUB-01", "S-HUB-02"];
const MODELS = ["M-A1"];
const BATCHES = ["CB-2026Q3"];
const FW = { version: "fw-2.1.0", digest: "sha256:9f2c1a7e4b6d8f03a5c7e9d1b2f4a6c8", installedAt: "2026-09-20T02:00:00.000Z" };

type DB = ReturnType<typeof openMigratedDatabase>;

interface SegSpec { seq: number; s: number; e: number; t0: string; t1: string; reset?: boolean }

function session(svc: CanaryService, db: DB, device: string, sid: string, segs: SegSpec[]): void {
  const startedAt = segs[0].t0;
  const endedAt = segs[segs.length - 1].t1;
  svc.ingestSession({ sessionId: sid, deviceId: device, startedAt, endedAt });
  for (const g of segs) {
    svc.ingestSegment({
      sessionId: sid, seq: g.seq, startReadingMwh: g.s, endReadingMwh: g.e,
      startedAt: g.t0, endedAt: g.t1, resetAfterPrevious: g.reset,
    });
  }
  void db;
}

function enroll(svc: CanaryService, device: string, site: string): void {
  svc.registerDevice({ deviceId: device, siteId: site, model: MODELS[0], calibrationBatch: BATCHES[0] });
  svc.claimDevice(WAVE, device);
  svc.checkin({ deviceId: device, firmwareVersion: FW.version, firmwareDigest: FW.digest, installedAt: FW.installedAt });
}

// —— 会话模板（站点本地为 UTC+8）——
// 平段：UTC 06:00-07:00 = 本地 14:00-15:00，两规都是 1.00 元
const flat = (day: string, kwh: number): SegSpec[] => {
  const m = kwh * 1_000_000;
  return [{ seq: 1, s: 0, e: m, t0: `${day}T06:00:00.000Z`, t1: `${day}T07:00:00.000Z` }];
};
// 跨零点：UTC 15:00-17:00 = 本地 23:00 至次日 01:00；23 点平价、00 点谷段 0.30 元
const midnight = (day: string, kwh: number): SegSpec[] => {
  const m = kwh * 1_000_000;
  return [{ seq: 1, s: 0, e: m, t0: `${day}T15:00:00.000Z`, t1: `${day}T17:00:00.000Z` }];
};
// 表计翻牌式复位：两段都在平段，隔离纯粹由复位找回金额触发，便于归因
const resetBig = (day: string, kwh1: number, kwh2: number): SegSpec[] => [
  // seq1 把旧表走到 9980kWh（本段 kwh1=20kWh），复位后新表 seq2 走了 kwh2=19kWh。
  // v1 不信任复位声明（末读数 19 < 9980）→ seq2 整片丢弃；v2 凭声明保留 19kWh。
  { seq: 1, s: (9_980 - kwh1) * 1_000_000, e: 9_980 * 1_000_000, t0: `${day}T06:00:00.000Z`, t1: `${day}T07:00:00.000Z` },
  { seq: 2, s: 0, e: kwh2 * 1_000_000, t0: `${day}T07:00:00.000Z`, t1: `${day}T08:00:00.000Z`, reset: true },
];

export function seedDemo(db: DB): { wave: string; traceSession: string } {
  let simMs = Date.parse("2026-09-20T00:00:00.000Z");
  const svc = new CanaryService(db, 480, () => simMs);

  svc.registerRule(currentRuleV1(T0));
  svc.registerRule(candidateRuleV2(T0));
  svc.createWave({
    waveId: WAVE, scopeSites: SITES, scopeModels: MODELS, scopeBatches: BATCHES,
    currentRuleVersion: "metering-v1", candidateRuleVersion: "metering-v2",
    // 波次级门槛：候选含 TOU，预期健康设备有个位数价差，差异率放到 10%、绝对额 ¥50
    thresholds: { maxAmountDeltaRate: 0.1, maxAmountDeltaCents: 5_000 },
  });

  enroll(svc, "D-OK-01", "S-HUB-01");   // 健康（含 1 个跨零点会话）
  enroll(svc, "D-OK-02", "S-HUB-02");   // 健康（纯平段）
  enroll(svc, "D-NEG-01", "S-HUB-01");  // 负增量
  enroll(svc, "D-GAP-01", "S-HUB-02");  // 缺片
  enroll(svc, "D-AMT-01", "S-HUB-01");  // 异常复位→金额差异超绝对门槛
  enroll(svc, "D-FEW-01", "S-HUB-02");  // 样本不足

  const D = "2026-09-21";
  // D-OK-01：10 + 4(跨零点) + 8 kWh；跨零点会话 v1 ¥4.00 全归 21 日，v2 拆为 ¥2.00(21日)+¥0.60(22日)
  session(svc, db, "D-OK-01", "S-OK1-1", flat(D, 10));
  session(svc, db, "D-OK-01", "S-OK1-2", midnight(D, 4));
  session(svc, db, "D-OK-01", "S-OK1-3", flat(D, 8));
  // D-OK-02：12 + 6 + 5 kWh 纯平段，两规完全一致
  session(svc, db, "D-OK-02", "S-OK2-1", flat(D, 12));
  session(svc, db, "D-OK-02", "S-OK2-2", flat(D, 6));
  session(svc, db, "D-OK-02", "S-OK2-3", flat(D, 5));

  // D-NEG-01：一个会话片内负增量（10kWh→9kWh），两规都丢弃该片，但负增量信号超门槛
  session(svc, db, "D-NEG-01", "S-NEG-1", [{ seq: 1, s: 10_000_000, e: 9_000_000, t0: `${D}T06:00:00.000Z`, t1: `${D}T07:00:00.000Z` }]);
  session(svc, db, "D-NEG-01", "S-NEG-2", flat(D, 7));
  session(svc, db, "D-NEG-01", "S-NEG-3", flat(D, 7));

  // D-GAP-01：一个会话缺失 seq=3（仅上报 1,2,4），缺片率 1/4，全部平段
  session(svc, db, "D-GAP-01", "S-GAP-1", [
    { seq: 1, s: 0, e: 3_000_000, t0: `${D}T06:00:00.000Z`, t1: `${D}T06:20:00.000Z` },
    { seq: 2, s: 3_000_000, e: 6_000_000, t0: `${D}T06:20:00.000Z`, t1: `${D}T06:40:00.000Z` },
    { seq: 4, s: 9_000_000, e: 12_000_000, t0: `${D}T07:20:00.000Z`, t1: `${D}T07:40:00.000Z` },
  ]);
  session(svc, db, "D-GAP-01", "S-GAP-2", flat(D, 6));
  session(svc, db, "D-GAP-01", "S-GAP-3", flat(D, 6));

  // D-AMT-01：每会话复位找回 19kWh，3 会话合计候选多计 ¥57.00，超 ¥50 绝对门槛
  session(svc, db, "D-AMT-01", "S-AMT-1", resetBig(D, 20, 19));
  session(svc, db, "D-AMT-01", "S-AMT-2", resetBig(D, 20, 19));
  session(svc, db, "D-AMT-01", "S-AMT-3", resetBig(D, 20, 19));

  // D-FEW-01：仅 1 个完整会话 → 样本不足暂缓
  session(svc, db, "D-FEW-01", "S-FEW-1", flat(D, 5));

  // 双规则比较（按会话事务、可续算），再裁决、隔离
  const job = new ComparisonJob(svc, db);
  const progress = job.runToCompletion(WAVE);
  if (progress.remaining) throw new Error("演示数据应当一次比较完成");
  new Adjudication(svc, db).decide(WAVE, "demo");

  // 封账 09-21：尚未晋级，全部按现行 v1 入账；跨零点会话的 21 日部分 ¥4.00 入账
  simMs = Date.parse("2026-09-22T00:30:00.000Z");
  svc.sealPeriod(D, "demo-clearing");

  // 封账后 S-OK1-2 迟到补传 seq2（本地 09-22 凌晨 01:00-01:30，2kWh）：
  // v1 把它归到会话起始日 21 日 → 重算应为 ¥6.00，但账已封，只产生 +¥2.00 调整建议
  simMs = Date.parse("2026-09-22T00:45:00.000Z");
  svc.ingestSegment({
    sessionId: "S-OK1-2", seq: 2, startReadingMwh: 4_000_000, endReadingMwh: 6_000_000,
    startedAt: "2026-09-21T17:00:00.000Z", endedAt: "2026-09-21T17:30:00.000Z",
  });
  const adviceCount = generateLateAdvices(svc, db);
  if (adviceCount !== 1) throw new Error(`演示期望 1 条调整建议，实际 ${adviceCount}`);

  // 双签（计量 + 清算）→ 晋级（本地 09:00）
  simMs = Date.parse("2026-09-22T01:00:00.000Z");
  svc.approve(WAVE, "metering_lead", "张计量", "approved", "负增量与缺片门槛有效，隔离项明确");
  svc.approve(WAVE, "clearing_lead", "李清算", "approved", "金额差异可归因，封账部分仅走调整建议");
  svc.promote(WAVE, "demo-ops");

  // 晋级后健康设备的新会话（本地 10:00 峰段 10kWh）→ 按候选 v2 入账 ¥15.00
  simMs = Date.parse("2026-09-22T04:00:00.000Z");
  svc.ingestSession({
    sessionId: "S-OK1-POST", deviceId: "D-OK-01",
    startedAt: "2026-09-22T02:00:00.000Z", endedAt: "2026-09-22T03:00:00.000Z",
  });
  svc.ingestSegment({
    sessionId: "S-OK1-POST", seq: 1, startReadingMwh: 0, endReadingMwh: 10_000_000,
    startedAt: "2026-09-22T02:00:00.000Z", endedAt: "2026-09-22T03:00:00.000Z",
  });
  simMs = Date.parse("2026-09-23T00:30:00.000Z");
  svc.sealPeriod("2026-09-22", "demo-clearing");

  // 回滚：后续会话回落 v1；已按 v2 入账的 ¥15.00 原样保留，规则版本留在结算行
  simMs = Date.parse("2026-09-23T01:00:00.000Z");
  svc.rollback(WAVE, "峰谷时段配置需要修订，回滚候选规则", "demo-ops");

  return { wave: WAVE, traceSession: "S-OK1-2" };
}

function main(): void {
  const dbPath = process.env.APP_DB_PATH ?? "data/demo.sqlite3";
  const db = openMigratedDatabase(dbPath);
  const { wave, traceSession } = seedDemo(db);

  const reporting = new Reporting(db);
  const report = reporting.buildWaveReport(wave);
  const md = renderWaveReport(report);
  const trace = reporting.traceDifference(wave, traceSession);

  mkdirSync("reports", { recursive: true });
  writeFileSync(join("reports", "canary-report.md"), md, "utf8");
  writeFileSync(join("reports", "trace-example.json"), JSON.stringify(trace, null, 2), "utf8");
  console.log(md);
  console.log(`\n报告已写入 reports/canary-report.md；反查样例 reports/trace-example.json（数据库 ${dbPath}）`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
