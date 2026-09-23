-- 计量固件灰度结算护栏
-- 所有规则一经冻结即不可变；新旧固件在同一会话内按各自冻结规则分别计算，
-- 封账账期不被迟到数据改写，只产生调整建议。

CREATE TABLE firmware_versions (
  firmware_id   TEXT PRIMARY KEY,
  digest        TEXT NOT NULL UNIQUE,
  version_label TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- 冻结的计量/计价规则。role='incumbent' 为现行规则，'candidate' 为候选规则。
CREATE TABLE rule_versions (
  rule_id     TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('incumbent','candidate')),
  label       TEXT NOT NULL,
  payload_json TEXT NOT NULL,          -- 单价/舍入/负增量策略/异常复位策略/满量程
  frozen_at   TEXT NOT NULL
);

CREATE TABLE release_waves (
  wave_id                TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  site_ids_json          TEXT NOT NULL,   -- 限定站点
  device_models_json     TEXT NOT NULL,   -- 限定设备型号
  calibration_batches_json TEXT NOT NULL, -- 限定校准批次
  incumbent_rule_id      TEXT NOT NULL REFERENCES rule_versions(rule_id),
  candidate_rule_id      TEXT NOT NULL REFERENCES rule_versions(rule_id),
  candidate_firmware_id  TEXT NOT NULL REFERENCES firmware_versions(firmware_id),
  thresholds_json        TEXT NOT NULL,   -- 负增量率/缺片率/样本量/金额差异门槛
  state                  TEXT NOT NULL DEFAULT 'active'
                           CHECK (state IN ('active','promoted','rolled_back','closed')),
  created_at             TEXT NOT NULL,
  decided_at             TEXT
);

CREATE TABLE devices (
  device_id          TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL,
  model              TEXT NOT NULL,
  calibration_batch  TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'normal'
                       CHECK (state IN ('normal','isolated')),
  current_wave_id    TEXT REFERENCES release_waves(wave_id),
  isolated_reason    TEXT,
  isolated_at        TEXT,
  created_at         TEXT NOT NULL
);
-- 设备同时只能被一个波次认领：认领 UPDATE 必须命中 current_wave_id IS NULL 的行。

-- 波次认领历史（追加，不删除）：保证两个波次同时认领时唯一归属可追溯。
CREATE TABLE wave_devices (
  wave_id        TEXT NOT NULL REFERENCES release_waves(wave_id),
  device_id      TEXT NOT NULL REFERENCES devices(device_id),
  claimed_at     TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT,
  PRIMARY KEY (wave_id, device_id)
);

-- 设备签到：携带固件摘要、安装时刻与回滚缘由；重复回报不新建记录。
CREATE TABLE device_checkins (
  checkin_id       TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(device_id),
  wave_id          TEXT REFERENCES release_waves(wave_id),
  firmware_id      TEXT NOT NULL REFERENCES firmware_versions(firmware_id),
  idempotency_key  TEXT NOT NULL,
  installed_at     TEXT NOT NULL,
  rollback_reason  TEXT,
  reported_at      TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  is_late          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, idempotency_key)
);

CREATE TABLE accounting_periods (
  period_id  TEXT PRIMARY KEY,          -- 账期日期 'YYYY-MM-DD'（零点切段）
  started_at TEXT NOT NULL,
  ended_at   TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  closed_at  TEXT
);

-- 充电会话：跨固件版本时表读数（累计绝对值）始终保留，不随升级/回滚清零。
CREATE TABLE charging_sessions (
  session_id            TEXT PRIMARY KEY,
  device_id             TEXT NOT NULL REFERENCES devices(device_id),
  wave_id               TEXT REFERENCES release_waves(wave_id),
  client_session_id     TEXT NOT NULL,
  period_id             TEXT NOT NULL REFERENCES accounting_periods(period_id),
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  start_reading         REAL,
  end_reading           REAL,
  firmware_timeline_json TEXT NOT NULL DEFAULT '[]', -- [{at,firmwareId,reading}]
  booked_rule_id        TEXT REFERENCES rule_versions(rule_id), -- 实际记账所用规则
  state                 TEXT NOT NULL DEFAULT 'collecting'
                          CHECK (state IN ('collecting','complete')),
  created_at            TEXT NOT NULL,
  UNIQUE (device_id, client_session_id)
);

-- 计量片段：幂等入库；迟到片段照收但标记，不改写已封账账期。
CREATE TABLE meter_fragments (
  fragment_id      TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES charging_sessions(session_id),
  device_id        TEXT NOT NULL REFERENCES devices(device_id),
  idempotency_key  TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  period_id        TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  reading_start    REAL NOT NULL,
  reading_end      REAL NOT NULL,
  firmware_id      TEXT NOT NULL REFERENCES firmware_versions(firmware_id),
  is_candidate     INTEGER NOT NULL DEFAULT 0,
  is_late          INTEGER NOT NULL DEFAULT 0,
  received_at      TEXT NOT NULL,
  UNIQUE (device_id, idempotency_key),
  UNIQUE (session_id, seq)
);

-- 会话 × 冻结规则 的双算结果（现行、候选各一行）。
CREATE TABLE session_calculations (
  calculation_id      TEXT PRIMARY KEY,
  wave_id             TEXT NOT NULL REFERENCES release_waves(wave_id),
  session_id          TEXT NOT NULL REFERENCES charging_sessions(session_id),
  rule_id             TEXT NOT NULL REFERENCES rule_versions(rule_id),
  rule_role           TEXT NOT NULL CHECK (rule_role IN ('incumbent','candidate')),
  energy_kwh          REAL NOT NULL,
  amount_cents        INTEGER NOT NULL,
  negative_increments INTEGER NOT NULL,
  reset_events        INTEGER NOT NULL,
  missing_fragments   INTEGER NOT NULL,
  expected_fragments  INTEGER NOT NULL,
  period_amounts_json TEXT NOT NULL DEFAULT '{}',  -- {'YYYY-MM-DD': cents} 跨零点分摊
  detail_json         TEXT NOT NULL,
  computed_at         TEXT NOT NULL,
  UNIQUE (wave_id, session_id, rule_id)
);

-- 比较作业：中断后凭 wave_session_comparisons 已完成行从断点续算。
CREATE TABLE comparison_runs (
  run_id        TEXT PRIMARY KEY,
  wave_id       TEXT NOT NULL REFERENCES release_waves(wave_id),
  state         TEXT NOT NULL
                  CHECK (state IN ('running','interrupted','completed')),
  total_sessions INTEGER,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  last_error    TEXT
);

CREATE TABLE wave_session_comparisons (
  wave_id            TEXT NOT NULL REFERENCES release_waves(wave_id),
  session_id         TEXT NOT NULL REFERENCES charging_sessions(session_id),
  device_id          TEXT NOT NULL REFERENCES devices(device_id),
  run_id             TEXT NOT NULL REFERENCES comparison_runs(run_id),
  incumbent_calc_id  TEXT NOT NULL REFERENCES session_calculations(calculation_id),
  candidate_calc_id  TEXT NOT NULL REFERENCES session_calculations(calculation_id),
  incumbent_cents    INTEGER NOT NULL,
  candidate_cents    INTEGER NOT NULL,
  booked_cents       INTEGER NOT NULL,  -- 已封账快照金额（session_bookings 合计）
  baseline_cents     INTEGER NOT NULL,  -- 现行规则 × 按时片段（含未封账账期）的基线
  data_gap_cents     INTEGER NOT NULL,
  rule_delta_cents   INTEGER NOT NULL,
  delta_cents        INTEGER NOT NULL,  -- 候选 − 基线 = 规则价差 + 数据缺口
  touches_closed     INTEGER NOT NULL DEFAULT 0,
  has_late           INTEGER NOT NULL DEFAULT 0,
  risk_flags_json    TEXT NOT NULL DEFAULT '[]',
  fragments_hash     TEXT NOT NULL,
  compared_at        TEXT NOT NULL,
  PRIMARY KEY (wave_id, session_id)
);

-- 封账快照：账期关闭时按当时已到片段与现行规则落账，迟到数据永远不得改写。
CREATE TABLE session_bookings (
  session_id   TEXT NOT NULL REFERENCES charging_sessions(session_id),
  period_id    TEXT NOT NULL REFERENCES accounting_periods(period_id),
  booked_rule_id TEXT NOT NULL REFERENCES rule_versions(rule_id),
  amount_cents INTEGER NOT NULL,
  fragment_count INTEGER NOT NULL,
  booked_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, period_id)
);

-- 设备级指标与裁决：可晋级 / 必须隔离 / 样本不足。
CREATE TABLE wave_device_metrics (
  wave_id              TEXT NOT NULL REFERENCES release_waves(wave_id),
  device_id            TEXT NOT NULL REFERENCES devices(device_id),
  session_count        INTEGER NOT NULL,
  negative_rate        REAL NOT NULL,
  missing_rate         REAL NOT NULL,
  amount_diff_abs_cents INTEGER NOT NULL,
  amount_net_cents     INTEGER NOT NULL,
  data_gap_cents       INTEGER NOT NULL,  -- 迟到/缺片在现行规则下造成的金额差
  rule_delta_cents     INTEGER NOT NULL,  -- 同片段下候选规则相对现行规则的价差
  amount_diff_rel      REAL NOT NULL,
  decision             TEXT NOT NULL
                         CHECK (decision IN ('promote','isolate','pending_sample')),
  reasons_json         TEXT NOT NULL DEFAULT '[]',
  computed_at          TEXT NOT NULL,
  PRIMARY KEY (wave_id, device_id)
);

-- 计量负责人、清算负责人分别确认（双签）。
CREATE TABLE wave_approvals (
  wave_id     TEXT NOT NULL REFERENCES release_waves(wave_id),
  role        TEXT NOT NULL CHECK (role IN ('metering','clearing')),
  approver    TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  approved_at TEXT NOT NULL,
  PRIMARY KEY (wave_id, role)
);

-- 规则绑定：双签晋级后对后续会话生效；回滚只置 revoked，行永久保留。
CREATE TABLE rule_bindings (
  binding_id    TEXT PRIMARY KEY,
  wave_id       TEXT NOT NULL REFERENCES release_waves(wave_id),
  device_id     TEXT REFERENCES devices(device_id),  -- NULL = 波次范围生效
  rule_id       TEXT NOT NULL REFERENCES rule_versions(rule_id),
  firmware_id   TEXT NOT NULL REFERENCES firmware_versions(firmware_id),
  state         TEXT NOT NULL CHECK (state IN ('effective','revoked')),
  effective_at  TEXT NOT NULL,
  revoked_at    TEXT,
  revoke_reason TEXT
);

-- 已封账部分的差异只形成调整建议，不回改账期。
CREATE TABLE adjustment_proposals (
  proposal_id      TEXT PRIMARY KEY,
  wave_id          TEXT NOT NULL REFERENCES release_waves(wave_id),
  device_id        TEXT NOT NULL REFERENCES devices(device_id),
  period_id        TEXT NOT NULL REFERENCES accounting_periods(period_id),
  session_id       TEXT NOT NULL REFERENCES charging_sessions(session_id),
  booked_rule_id   TEXT NOT NULL REFERENCES rule_versions(rule_id),
  proposed_rule_id TEXT NOT NULL REFERENCES rule_versions(rule_id),
  booked_cents     INTEGER NOT NULL,
  proposed_cents   INTEGER NOT NULL,
  delta_cents      INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'proposed'
                     CHECK (state IN ('proposed','accepted','rejected')),
  created_at       TEXT NOT NULL,
  UNIQUE (wave_id, session_id, period_id)
);

-- 波次守恒汇总：会话差之和 = 设备差之和 = 总差，并附会话指纹。
CREATE TABLE wave_summaries (
  summary_id            TEXT PRIMARY KEY,
  wave_id               TEXT NOT NULL UNIQUE REFERENCES release_waves(wave_id),
  run_id                TEXT NOT NULL REFERENCES comparison_runs(run_id),
  devices_total         INTEGER NOT NULL,
  devices_promote       INTEGER NOT NULL,
  devices_isolate       INTEGER NOT NULL,
  devices_pending       INTEGER NOT NULL,
  sessions_compared     INTEGER NOT NULL,
  incumbent_cents_total INTEGER NOT NULL,
  candidate_cents_total INTEGER NOT NULL,
  booked_cents_total    INTEGER NOT NULL,
  baseline_cents_total  INTEGER NOT NULL,
  delta_cents_total     INTEGER NOT NULL,
  conservation_ok       INTEGER NOT NULL,
  sessions_hash         TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
