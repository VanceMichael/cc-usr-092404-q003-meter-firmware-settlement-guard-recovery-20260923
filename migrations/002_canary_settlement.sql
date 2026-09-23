-- 计量固件灰度结算护栏：002 域模型
-- 约定：金额一律以“分”整数存储；时间一律存 ISO8601 带偏移字符串；规则只追加、永不修改。

-- 设备台账：波次认领的站点/型号/校准批次范围以此为准
CREATE TABLE IF NOT EXISTS devices (
  device_id          TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL,
  model              TEXT NOT NULL,
  calibration_batch  TEXT NOT NULL,
  registered_at      TEXT NOT NULL
);

-- 冻结的计量规则（现行 / 候选）。definition 为不可变 JSON
CREATE TABLE IF NOT EXISTS metering_rules (
  rule_version   TEXT PRIMARY KEY,
  family         TEXT NOT NULL CHECK (family IN ('current', 'candidate')),
  definition     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 发布波次：每波限定站点、设备型号、校准批次与门槛
CREATE TABLE IF NOT EXISTS release_waves (
  wave_id                TEXT PRIMARY KEY,
  scope_sites            TEXT NOT NULL,        -- JSON 数组
  scope_models           TEXT NOT NULL,        -- JSON 数组
  scope_batches          TEXT NOT NULL,        -- JSON 数组
  current_rule_version   TEXT NOT NULL,
  candidate_rule_version TEXT NOT NULL,
  thresholds             TEXT NOT NULL,        -- JSON：负增量/缺片率/样本量/金额差异
  status                 TEXT NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'decided', 'promoted', 'rolled_back', 'closed')),
  created_at             TEXT NOT NULL,
  decided_at             TEXT,
  promoted_at            TEXT,
  rolled_back_at         TEXT
);

-- 设备认领：同一时刻一台设备只能被一个波次 active 认领
CREATE TABLE IF NOT EXISTS device_claims (
  claim_id      TEXT PRIMARY KEY,
  wave_id       TEXT NOT NULL REFERENCES release_waves(wave_id),
  device_id     TEXT NOT NULL REFERENCES devices(device_id),
  status        TEXT NOT NULL CHECK (status IN ('active', 'released', 'isolated', 'promoted')),
  claimed_at    TEXT NOT NULL,
  released_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_one_active_device
  ON device_claims(device_id) WHERE status IN ('active', 'promoted');

-- 设备签到：携带固件摘要、安装时刻、回滚缘由；重复回报不新建记录
CREATE TABLE IF NOT EXISTS device_checkins (
  checkin_id       TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(device_id),
  wave_id          TEXT REFERENCES release_waves(wave_id),
  firmware_version TEXT NOT NULL,
  firmware_digest  TEXT NOT NULL,
  installed_at     TEXT NOT NULL,
  rollback_reason  TEXT,
  observed_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (device_id, firmware_digest, installed_at)
);

-- 账期（站点本地日）：open 可改，sealed 后只允许产生调整建议
CREATE TABLE IF NOT EXISTS billing_periods (
  period_date  TEXT PRIMARY KEY,             -- YYYY-MM-DD（本地时区）
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sealed')),
  sealed_at    TEXT
);

-- 充电会话（设备生成的 session_id 即幂等键）
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL REFERENCES devices(device_id),
  wave_id        TEXT REFERENCES release_waves(wave_id),  -- 按会话开始时刻的 active 认领归属
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  is_complete    INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  last_update_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_wave ON sessions(wave_id);

-- 计量片段：同一 (session, seq) 重复上报走 upsert，不新建记录
CREATE TABLE IF NOT EXISTS segments (
  segment_id            TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(session_id),
  seq                   INTEGER NOT NULL,
  checkin_id            TEXT REFERENCES device_checkins(checkin_id),
  start_reading_mwh     INTEGER NOT NULL,     -- 累计表读数，毫瓦时，跨固件版本不复位
  end_reading_mwh       INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  ended_at              TEXT NOT NULL,
  reset_after_previous  INTEGER NOT NULL DEFAULT 0, -- 固件声明：相对上一片发生过表计复位
  arrived_after_seal    INTEGER NOT NULL DEFAULT 0, -- 到达时所属账期已封账
  received_at           TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

-- 比较作业：事务按会话提交，中断后从已完成会话续算
CREATE TABLE IF NOT EXISTS comparison_runs (
  run_id         TEXT PRIMARY KEY,
  wave_id        TEXT NOT NULL REFERENCES release_waves(wave_id),
  status         TEXT NOT NULL CHECK (status IN ('running', 'done', 'interrupted')),
  sessions_total INTEGER NOT NULL DEFAULT 0,
  sessions_done  INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

-- 会话级双规则比较结果
CREATE TABLE IF NOT EXISTS session_comparisons (
  wave_id         TEXT NOT NULL REFERENCES release_waves(wave_id),
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  run_id          TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  current_cents   INTEGER NOT NULL,
  candidate_cents INTEGER NOT NULL,
  delta_cents     INTEGER NOT NULL,
  components      TEXT NOT NULL,  -- {midnightTransfer:{date->cents}, resetCents, priceCents}
  per_period      TEXT NOT NULL,  -- [{date, currentCents, candidateCents}]
  negative_count  INTEGER NOT NULL,
  reset_count     INTEGER NOT NULL,
  missing_rate    REAL NOT NULL,
  compared_at     TEXT NOT NULL,
  PRIMARY KEY (wave_id, session_id)
);

-- 设备裁决
CREATE TABLE IF NOT EXISTS wave_device_verdicts (
  wave_id      TEXT NOT NULL REFERENCES release_waves(wave_id),
  device_id    TEXT NOT NULL REFERENCES devices(device_id),
  decision     TEXT NOT NULL CHECK (decision IN ('promote', 'quarantine', 'blocked', 'observe', 'pending')),
  reasons      TEXT NOT NULL,       -- JSON 字符串数组
  metrics      TEXT NOT NULL,       -- JSON：样本/缺片/负增量/金额差异
  decided_at   TEXT NOT NULL,
  PRIMARY KEY (wave_id, device_id)
);

-- 双签审批：计量负责人与清算负责人各一行
CREATE TABLE IF NOT EXISTS wave_approvals (
  wave_id     TEXT NOT NULL REFERENCES release_waves(wave_id),
  role        TEXT NOT NULL CHECK (role IN ('metering_lead', 'clearing_lead')),
  approver    TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment     TEXT,
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (wave_id, role)
);

-- 会话结算：每会话每账期至多一条生效行；回滚也保留采用过的规则版本
CREATE TABLE IF NOT EXISTS session_settlements (
  settlement_id  TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(session_id),
  period_date    TEXT NOT NULL,
  wave_id        TEXT REFERENCES release_waves(wave_id),
  rule_version   TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('preliminary', 'booked', 'reversed')),
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_effective
  ON session_settlements(session_id, period_date) WHERE status IN ('preliminary', 'booked');

-- 已封账账期：只提调整建议，绝不改账
CREATE TABLE IF NOT EXISTS adjustment_advices (
  advice_id            TEXT PRIMARY KEY,
  period_date          TEXT NOT NULL,
  session_id           TEXT NOT NULL REFERENCES sessions(session_id),
  wave_id              TEXT NOT NULL,
  booked_rule_version  TEXT NOT NULL,
  booked_cents         INTEGER NOT NULL,
  advised_rule_version TEXT NOT NULL,
  advised_cents        INTEGER NOT NULL,
  delta_cents          INTEGER NOT NULL,
  reason               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  created_at           TEXT NOT NULL,
  UNIQUE (period_date, session_id)
);

-- 追加式审计日志（审批、晋级、隔离、回滚等）
CREATE TABLE IF NOT EXISTS audit_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  type        TEXT NOT NULL,
  wave_id     TEXT,
  device_id   TEXT,
  session_id  TEXT,
  payload     TEXT NOT NULL DEFAULT '{}'
);
