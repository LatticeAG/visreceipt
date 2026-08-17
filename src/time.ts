const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isIsoMsZ(value: string): boolean {
  if (!ISO_MS_Z.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function isTimeRegression(prev: string, next: string): boolean {
  return Date.parse(next) < Date.parse(prev);
}
