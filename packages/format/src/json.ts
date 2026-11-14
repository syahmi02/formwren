export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEmptyContainer(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

export function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Compares by content. Key order doesn't matter. */
export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i] as JsonValue));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => hasOwn(b, key) && deepEqual(a[key] as JsonValue, b[key] as JsonValue))
    );
  }
  return false;
}

/** Text that's identical for values with the same content, whatever their key order. */
export function contentKey(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(contentKey).join(',')}]`;
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${contentKey(value[key] as JsonValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Copies a value that's about to be written, and refuses anything JSON can't hold exactly.
 * `JSON.stringify` would quietly turn NaN into null and drop functions, which could lose data.
 * A property set to undefined means "no such property".
 */
export function toJsonValue(value: unknown, path = 'value'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`${path} is ${value}, which a form file can't hold`);
  }
  if (Array.isArray(value)) return value.map((item, i) => toJsonValue(item, `${path}[${i}]`));
  const prototype = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (prototype === Object.prototype || prototype === null) {
    const copy: JsonObject = {};
    for (const [key, item] of Object.entries(value as object)) {
      if (key === '__proto__') throw new TypeError(`${path} has the key "__proto__", which a form file can't hold`);
      if (item !== undefined) copy[key] = toJsonValue(item, `${path}.${key}`);
    }
    return copy;
  }
  throw new TypeError(`${path} is a ${typeof value === 'object' ? 'non-plain object' : typeof value}, which a form file can't hold`);
}
