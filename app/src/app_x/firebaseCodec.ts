export const FIREBASE_EMPTY_OBJECT = "__EMPTY_OBJECT_FIREBASE__";
export const FIREBASE_EMPTY_ARRAY = "__EMPTY_ARRAY_FIREBASE__";
export const FIREBASE_UNDEFINED = "__UNDEFINED_FIREBASE__";

export function encodeFirebaseValue(value: unknown): unknown {
  if (value === undefined) {
    return FIREBASE_UNDEFINED;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return FIREBASE_EMPTY_ARRAY;
    }

    return value.map(encodeFirebaseValue);
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value).map(([key, nested]) => [
      key,
      encodeFirebaseValue(nested),
    ]);

    if (entries.length === 0) {
      return FIREBASE_EMPTY_OBJECT;
    }

    return Object.fromEntries(entries);
  }

  return value;
}

export function decodeFirebaseValue(value: unknown): unknown {
  if (value === FIREBASE_EMPTY_OBJECT) {
    return {};
  }

  if (value === FIREBASE_EMPTY_ARRAY) {
    return [];
  }

  if (value === FIREBASE_UNDEFINED) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(decodeFirebaseValue);
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, decodeFirebaseValue(nested)]),
    );
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
