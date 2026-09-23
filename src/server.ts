import Koa from "koa";
import Router from "@koa/router";
import type { Database as DB } from "better-sqlite3";
import { openDatabase } from "./db.js";
import { GrayscaleService, GuardrailError } from "./grayscale.js";
import { buildWaveReport, renderWaveMarkdown, traceDifference } from "./report.js";

async function readJson(ctx: Koa.ParameterizedContext): Promise<any> {
  if (ctx.method === "GET") return {};
  return await new Promise((resolve, reject) => {
    let data = "";
    ctx.req.setEncoding("utf8");
    ctx.req.on("data", (chunk: string) => (data += chunk));
    ctx.req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    ctx.req.on("error", reject);
  });
}

export function createApp(database?: DB) {
  const db = database ?? openDatabase();
  const service = new GrayscaleService(db);
  const app = new Koa();
  const router = new Router();

  const handle = (fn: (ctx: Koa.ParameterizedContext, body: any) => unknown | Promise<unknown>) => async (ctx: Koa.ParameterizedContext) => {
    try {
      const body = await readJson(ctx);
      const result = await fn(ctx, body);
      if (ctx.body !== undefined && typeof ctx.body === "string") return;
      ctx.body = result ?? { ok: true };
    } catch (err) {
      if (err instanceof GuardrailError) {
        ctx.status = 422;
        ctx.body = { error: err.code, message: err.message };
        return;
      }
      if (err instanceof SyntaxError) {
        ctx.status = 400;
        ctx.body = { error: "BAD_JSON", message: "请求体不是合法 JSON" };
        return;
      }
      throw err;
    }
  };

  router.get("/health", (ctx) => {
    ctx.body = { status: "ok", service: "charging-clearing" };
  });

  // ---- 基础登记 ----
  router.post(
    "/admin/firmwares",
    handle((_ctx, body) => {
      service.registerFirmware({
        firmwareId: body.firmwareId,
        digest: body.digest,
        versionLabel: body.versionLabel,
      });
      return { ok: true };
    })
  );

  router.post(
    "/admin/rules",
    handle((_ctx, body) => {
      service.registerRule({
        ruleId: body.ruleId,
        role: body.role,
        label: body.label,
        payload: body.payload,
      });
      return { ok: true };
    })
  );

  router.post(
    "/admin/devices",
    handle((_ctx, body) => {
      service.registerDevice({
        deviceId: body.deviceId,
        siteId: body.siteId,
        model: body.model,
        calibrationBatch: body.calibrationBatch,
      });
      return { ok: true };
    })
  );

  // ---- 波次 ----
  router.post(
    "/waves",
    handle((_ctx, body) => {
      service.createWave({
        waveId: body.waveId,
        name: body.name,
        siteIds: body.siteIds,
        deviceModels: body.deviceModels,
        calibrationBatches: body.calibrationBatches,
        incumbentRuleId: body.incumbentRuleId,
        candidateRuleId: body.candidateRuleId,
        candidateFirmwareId: body.candidateFirmwareId,
        thresholds: body.thresholds,
      });
      return { ok: true, waveId: body.waveId };
    })
  );

  router.post(
    "/waves/:waveId/claim",
    handle((ctx, body) => {
      const outcome = service.claimDevice(ctx.params.waveId, body.deviceId);
      return { outcome };
    })
  );

  // ---- 设备侧 ----
  router.post(
    "/devices/:deviceId/checkins",
    handle((ctx, body) => {
      return service.checkin({
        deviceId: ctx.params.deviceId,
        firmwareId: body.firmwareId,
        idempotencyKey: body.idempotencyKey,
        installedAt: body.installedAt,
        rollbackReason: body.rollbackReason,
        reportedAt: body.reportedAt,
      });
    })
  );

  router.post(
    "/devices/:deviceId/fragments",
    handle((ctx, body) => {
      const listInput = Array.isArray(body) ? body : body?.fragments;
      if (!Array.isArray(listInput)) {
        ctx.status = 400;
        return { error: "BAD_REQUEST", message: "请求体须为片段数组或 { fragments: [...] }" };
      }
      const reports = listInput.map((f: any) => ({
        fragmentId: f.fragmentId,
        idempotencyKey: f.idempotencyKey,
        seq: f.seq,
        clientSessionId: f.clientSessionId,
        startedAt: f.startedAt,
        endedAt: f.endedAt,
        readingStart: Number(f.readingStart),
        readingEnd: Number(f.readingEnd),
        firmwareId: f.firmwareId,
        reportedAt: f.reportedAt ?? f.endedAt,
      }));
      return service.reportFragments(ctx.params.deviceId, reports);
    })
  );

  router.post(
    "/devices/:deviceId/sessions/:clientSessionId/complete",
    handle((ctx) => {
      service.completeSession(ctx.params.deviceId, ctx.params.clientSessionId);
      return { ok: true };
    })
  );

  // ---- 账期 ----
  router.post(
    "/periods/:day/close",
    handle((ctx) => {
      service.closePeriod(ctx.params.day);
      return { ok: true, periodId: ctx.params.day, state: "closed" };
    })
  );

  // ---- 比较 / 审批 / 回滚 ----
  router.post(
    "/waves/:waveId/compare",
    handle((ctx, body) => {
      const crashAfter = ctx.query.crashAfter !== undefined ? Number(ctx.query.crashAfter) : body?.crashAfter;
      return service.runComparison(ctx.params.waveId, {
        crashAfter: Number.isFinite(crashAfter) ? crashAfter : undefined,
      });
    })
  );

  router.post(
    "/waves/:waveId/approvals",
    handle((ctx, body) => {
      return service.approve(ctx.params.waveId, body.role, body.approver, body.decision ?? "approve");
    })
  );

  router.post(
    "/waves/:waveId/rollback",
    handle((ctx, body) => {
      service.rollback(ctx.params.waveId, body.reason);
      return { ok: true, state: "rolled_back" };
    })
  );

  // ---- 报告与反查 ----
  router.get("/waves/:waveId/report", (ctx) => {
    const report = buildWaveReport(db, ctx.params.waveId);
    const wantsMarkdown =
      ctx.query.format === "markdown" || (ctx.accepts("text/markdown") && !ctx.accepts("application/json"));
    if (wantsMarkdown) {
      ctx.type = "text/markdown; charset=utf-8";
      ctx.body = renderWaveMarkdown(report);
    } else {
      ctx.body = report;
    }
  });

  router.get("/waves/:waveId/sessions/:sessionId/trace", (ctx) => {
    ctx.body = traceDifference(db, ctx.params.waveId, ctx.params.sessionId);
  });

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof Error && /不存在|没有/.test(err.message)) {
        ctx.status = 404;
        ctx.body = { error: "NOT_FOUND", message: err.message };
        return;
      }
      throw err;
    }
  });
  app.use(router.routes()).use(router.allowedMethods());
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? "8080");
  createApp().listen(port, "0.0.0.0");
}
