// 站点本地时间工具：用固定 UTC 偏移描述“站点本地日”，避免容器时区影响跨零点切段。
export const LOCAL_OFFSET_MINUTES = Number(process.env.APP_LOCAL_UTC_OFFSET_MINUTES ?? "480"); // 默认 +08:00

export function epoch(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`非法时间: ${iso}`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 该时刻对应的站点本地日期 YYYY-MM-DD */
export function localDate(ms: number, offsetMinutes = LOCAL_OFFSET_MINUTES): string {
  const shifted = new Date(ms + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** 该本地日期 00:00 的 UTC epoch */
export function localMidnightUtc(date: string, offsetMinutes = LOCAL_OFFSET_MINUTES): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetMinutes * 60_000;
}

export function nextMidnightUtc(ms: number, offsetMinutes = LOCAL_OFFSET_MINUTES): number {
  const day = localDate(ms, offsetMinutes);
  const m0 = localMidnightUtc(day, offsetMinutes);
  return ms < m0 + 86_400_000 && ms >= m0 ? m0 + 86_400_000 : localMidnightUtc(localDate(ms + 86_400_000, offsetMinutes), offsetMinutes);
}

export function localHour(ms: number, offsetMinutes = LOCAL_OFFSET_MINUTES): number {
  return new Date(ms + offsetMinutes * 60_000).getUTCHours();
}

export function todayLocal(offsetMinutes = LOCAL_OFFSET_MINUTES): string {
  return localDate(Date.now(), offsetMinutes);
}
