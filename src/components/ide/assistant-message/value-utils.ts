export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const getNestedValue = (
  value: unknown,
  path: readonly string[],
): unknown => {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
};

export const getStringFromPaths = (
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
  options?: { allowEmpty?: boolean },
): string | null => {
  for (const path of paths) {
    const candidate = path.length === 0 ? value : getNestedValue(value, path);

    if (!isString(candidate)) {
      continue;
    }
    if (options?.allowEmpty || candidate.length > 0) {
      return candidate;
    }
  }

  return null;
};

export const getNumberFromPaths = (
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): number | null => {
  for (const path of paths) {
    const candidate = path.length === 0 ? value : getNestedValue(value, path);

    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return null;
};
