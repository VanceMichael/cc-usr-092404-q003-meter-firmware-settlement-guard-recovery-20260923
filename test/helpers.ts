import Database from "better-sqlite3";
import { GrayscaleService } from "../src/grayscale.js";
import { runMigrations } from "../src/db.js";

export const DAY1 = "2026-09-20";
export const DAY2 = "2026-09-21";

export const INCUMBENT = {
  ruleId: "rule-inc-v1",
  role: "incumbent" as const,
  label: "现行规则（负增量透传）",
  payload: {
    priceCentsPerKwh: 100,
    roundingMode: "round" as const,
    resetPolicy: "passthrough" as const,
    resetToleranceKwh: 50,
  },
};

export const CANDIDATE = {
  ruleId: "rule-cand-v2",
  role: "candidate" as const,
  label: "候选规则（复位归零）",
  payload: {
    priceCentsPerKwh: 100,
    roundingMode: "round" as const,
    resetPolicy: "clamp_zero" as const,
    resetToleranceKwh: 50,
  },
};

export function makeService() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const svc = new GrayscaleService(db);
  return { db, svc };
}

/** 搭好：新旧固件、冻结双规则、波次 W1（含一个范围外设备用的对照波次 W2）。 */
export function seedWorld(svc: GrayscaleService) {
  svc.registerFirmware({ firmwareId: "fw-old", digest: "sha256:old-firmware", versionLabel: "计量固件 v1" });
  svc.registerFirmware({ firmwareId: "fw-new", digest: "sha256:new-firmware", versionLabel: "计量固件 v2" });
  svc.registerRule(INCUMBENT);
  svc.registerRule(CANDIDATE);

  for (const [id, site, extra] of [
    ["D-GOOD", "S1", {}],
    ["D-BAD", "S1", {}],
    ["D-MISS", "S1", {}],
    ["D-LOW", "S1", {}],
    ["D-OUT", "S2", {}],
  ] as const) {
    svc.registerDevice({
      deviceId: id,
      siteId: site,
      model: "M1",
      calibrationBatch: "B1",
      ...extra,
    });
  }

  const thresholds = { maxNegativeRate: 0.05, maxMissingRate: 0.2, minSessions: 2, maxAmountDiffRel: 0.05 };
  svc.createWave({
    waveId: "W1",
    name: "9月第三批灰度",
    siteIds: ["S1"],
    deviceModels: ["M1"],
    calibrationBatches: ["B1"],
    incumbentRuleId: INCUMBENT.ruleId,
    candidateRuleId: CANDIDATE.ruleId,
    candidateFirmwareId: "fw-new",
    thresholds,
  });
  svc.createWave({
    waveId: "W2",
    name: "争抢波次",
    siteIds: ["S1"],
    deviceModels: ["M1"],
    calibrationBatches: ["B1"],
    incumbentRuleId: INCUMBENT.ruleId,
    candidateRuleId: CANDIDATE.ruleId,
    candidateFirmwareId: "fw-new",
    thresholds,
  });

  for (const id of ["D-GOOD", "D-BAD", "D-MISS", "D-LOW"]) {
    svc.claimDevice("W1", id);
  }
}

export function fragment(overrides: {
  fragmentId: string;
  idempotencyKey: string;
  seq: number;
  clientSessionId: string;
  startedAt: string;
  endedAt: string;
  readingStart: number;
  readingEnd: number;
  firmwareId?: string;
}) {
  const { firmwareId, ...rest } = overrides;
  return { firmwareId: firmwareId ?? "fw-new", reportedAt: overrides.endedAt, ...rest };
}
