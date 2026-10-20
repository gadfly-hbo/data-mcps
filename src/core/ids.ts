/** 进程内 ID 与时间工具（全仓唯一入口）。 */

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowUtc(): string {
  return new Date().toISOString();
}
