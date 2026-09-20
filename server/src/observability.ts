export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export function logInfo(
  scope: string,
  event: string,
  fields: LogFields = {},
): void {
  emit(console.log, "info", scope, event, fields);
}

export function logWarn(
  scope: string,
  event: string,
  fields: LogFields = {},
): void {
  emit(console.warn, "warn", scope, event, fields);
}

export function logError(
  scope: string,
  event: string,
  error: unknown,
  fields: LogFields = {},
): void {
  emit(console.error, "error", scope, event, {
    ...fields,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function emit(
  write: (...values: unknown[]) => void,
  level: string,
  scope: string,
  event: string,
  fields: LogFields,
): void {
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value!)}`)
    .join(" ");
  write(
    `${new Date().toISOString()} level=${level} scope=${scope} event=${event}${details ? ` ${details}` : ""}`,
  );
}

function formatValue(value: string | number | boolean | null): string {
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return /^[A-Za-z0-9._:/@+-]+$/.test(value) ? value : JSON.stringify(value);
}
