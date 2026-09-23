# 充电会话离线清分服务 · 计量固件灰度结算护栏

拼接站点离线补传的充电计量片段，并在新计量固件进入日结链路前提供灰度护栏：
**同一批片段以冻结的现行规则与候选规则分别计算**，裁决哪些设备可晋级、哪些必须隔离、金额风险来自哪里。

项目采用 Koa 与 TypeScript，保留独立迁移进程和可注入的应用构造函数（测试使用内存 SQLite）。

## 本地约定

数据库默认写入 `data/charging.sqlite3`，可通过 `APP_DB_PATH` 改为当前工程内的其他文件。服务不需要远程数据库或缓存。账期按 UTC 零点切段。

## 常用命令

```bash
npm install
npm run db:upgrade
npm test
npm start
```

Docker 镜像在构建阶段执行自动化测试，运行时监听 `PORT` 指定的端口，未设置时使用 8080。

## 开发检查

- 编译或构建：`npm run build`
- 类型检查：`npx tsc -p tsconfig.json --noEmit`

## 灰度结算护栏如何工作

1. **冻结规则**：`rule_versions.payload_json` 固化单价、舍入方式、异常复位策略
   （`passthrough` 透传负增量 / `clamp_zero` 复位归零只计数 / `wrap` 满量程绕回）。
   已冻结规则不可修改。
2. **发布波次限定范围**：站点、设备型号、校准批次三维白名单；设备由
   `devices.current_wave_id` 的条件更新保证同时只归属一个波次，认领历史追加保留。
3. **设备签到**：携带固件摘要、安装时刻、回滚缘由；`(device_id, idempotency_key)`
   幂等，重复回报不新建记录。回滚只留痕、不删除任何数据。
4. **跨版本会话**：同一会话升级/回滚固件不清零表读数，`firmware_timeline_json`
   记录每次固件切换点与当时读数。
5. **双规则计算**：比较作业对每个会话分别按现行/候选规则计算能量、金额、负增量、
   复位事件、缺片数；跨零点片段按时间比例分摊到各账期并逐账期舍入。
6. **封账不可变**：账期关闭时按当时已到片段、以**会话建档时固化的记账规则**落
   `session_bookings` 快照。迟到片段照收并打 `is_late`，但永不改写封账快照，只
   生成 `adjustment_proposals` 调整建议。
7. **门槛裁决**：负增量率、缺片率、样本会话数、同片段新旧规则金额相对差共同决定
   `promote / isolate / pending_sample`；超限设备立即隔离。
8. **双签晋级**：计量负责人与清算负责人分别批准后，候选规则才对**晋级之后新建的
   会话**生效（按设备写 `rule_bindings`，隔离设备不绑定）。
9. **回滚**：绑定置 `revoked`（行永久保留，含生效区间与缘由），之后新建会话回到
   现行规则；期间所有规则、固件、读数、计算结果均可追溯。
10. **断点续算**：比较作业以片段指纹增量处理，中断后再调只算未完成/已变化会话。
11. **守恒汇总**：`总净差 = 候选总额 − 现行基线总额 = 规则价差 + 迟到/缺片缺口`，
    且会话差之和 = 设备差之和；守恒失败拒绝出报告。汇总附会话 SHA-256 指纹。

## 主要 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/firmwares` `/admin/rules` `/admin/devices` | 登记固件（含摘要）、冻结规则、设备 |
| POST | `/waves` | 建波（范围 + 双规则 + 候选固件 + 门槛） |
| POST | `/waves/:waveId/claim` | 波次认领设备（范围外/重复归属被拒） |
| POST | `/devices/:deviceId/checkins` | 设备签到（幂等，含回滚缘由） |
| POST | `/devices/:deviceId/fragments` | 计量片段批量上报（幂等；数组或 `{fragments:[]}`） |
| POST | `/periods/:day/close` | 账期封账（此后写入只产生建议） |
| POST | `/waves/:waveId/compare` | 运行/续算双规则比较（支持 `?crashAfter=N` 演练中断） |
| POST | `/waves/:waveId/approvals` | 计量/清算负责人分别确认（双签晋级） |
| POST | `/waves/:waveId/rollback` | 回滚（撤销绑定、保留全部痕迹） |
| GET | `/waves/:waveId/report` | 灰度报告 JSON；`?format=markdown` 出 Markdown |
| GET | `/waves/:waveId/sessions/:sessionId/trace` | 由一笔差异反查固件摘要、冻结规则、读数区间、审批版本 |

领域逻辑集中在 `src/grayscale.ts`，规则解释器在 `src/metering.ts`，报告与反查在
`src/report.ts`；表结构见 `migrations/002_grayscale_guardrails.sql`。
