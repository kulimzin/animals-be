export const LOCATION_LABEL_MAX_LENGTH = 300;

export function normalizeOptionalText(value: string | null) {
  if (value === null) return null;
  const normalized = value.normalize('NFC').trim();
  return normalized.length === 0 ? null : normalized;
}

export function countUnicodeCodePoints(value: string) {
  return Array.from(value).length;
}
