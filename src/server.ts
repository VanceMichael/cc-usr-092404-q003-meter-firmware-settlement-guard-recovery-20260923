import Koa from "koa";
import Router from "@koa/router";
import type { Database as DB } from "better-sqlite3";
import { openMigratedDatabase } from "./db.js";
import { CanaryService, ConflictError, ValidationError } from "./service.js";
import { ComparisonJob } from "./jobs.js";
import { Reporting } from "./reporting.js";
import { renderWaveReport } from "./report-markdown.js";

export interface AppDeps {
  db?: DB;
}

export function createApp(deps: AppDeps = {}): Koa {
  const db = deps.db ?? openMigratedDatabase();
  const svc = new CanaryService(db);
  const reporting = new Reporting(db);

  const app = new Koa();
  const router = new Router();

  router.get("/health", (context) => {
    context.body = { status: "ok", service: "charging-clearing" };
  });

  // 灰度报告（JSON / Markdown）
  router.get("/waves/:waveId/report", (context) => {
    context.body = reporting.buildWaveReport(context.params.waveId);
  });
  router.get("/waves/:waveId/report.md", (context) => {
    context.type = "text/markdown; charset=utf-8";
    context.body = renderWaveReport(reporting.buildWaveReport(context.params.waveId));
  });

  // 一笔差异反查：固件 → 冻结规则 → 读数区间 → 分量 → 作业/审批版本 → 结算行/调整建议
  router.get("/waves/:waveId/trace/:sessionId", (context) => {
    context.body = reporting.traceDifference(context.params.waveId, context.params.sessionId);
  });

  // 续算比较作业（天然幂等：已完成会话自动跳过）
  router.post("/waves/:waveId/compare", (context) => {
    const progress = new ComparisonJob(svc, db).runToCompletion(context.params.waveId);
    context.body = progress;
  });

  // 双签审批
  router.post("/waves/:waveId/approvals", async (context) => {
    const body = (await parseJson(context)) as {
      role: "metering_lead" | "clearing_lead";
      approver: string;
      decision: "approved" | "rejected";
      comment?: string;
    };
    svc.approve(context.params.waveId, body.role, body.approver, body.decision, body.comment);
    context.status = 204;
  });

  app.use(async (context, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof ValidationError) {
        context.status = 400;
        context.body = { error: err.message };
      } else if (err instanceof ConflictError) {
        context.status = 409;
        context.body = { error: err.message };
      } else {
        throw err;
      }
    }
  });
  app.use(router.routes()).use(router.allowedMethods());
  return app;
}

async function parseJson(context: Koa.ParameterizedContext): Promise<unknown> {
  if (context.method === "GET") return {};
  let raw = "";
  for await (const chunk of context.req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? "8080");
  createApp().listen(port, "0.0.0.0");
}
