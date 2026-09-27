const CLI_VERSION_PATTERN = /\d+(?:\.\d+)+(?:[-+][\w.-]+)?/;

/**
 * Pulls the version number out of a CLI's `--version` output, e.g.
 * `codex-cli 0.156.1` -> `0.156.1`, `grok 1.0.41 (4220f3b) [stable]` ->
 * `1.0.41`. Falls back to the raw output when there is no version number.
 */
export const extractCliVersion = (output: string | null | undefined) => {
  if (!output) {
    return null;
  }

  return output.match(CLI_VERSION_PATTERN)?.[0] ?? output;
};

interface ParsedVersion {
  core: number[];
  prerelease: string | null;
}

const parseVersion = (value: string | null | undefined) => {
  const match = extractCliVersion(value)?.match(
    /^(\d+(?:\.\d+)+)(?:-([\w.-]+))?/,
  );
  if (!match) {
    return null;
  }

  return {
    core: match[1].split(".").map(Number),
    prerelease: match[2] ?? null,
  } satisfies ParsedVersion;
};

/**
 * True when `latest` is a newer release than the installed CLI. Only the
 * numeric part is ordered: suffixes like Cursor's build hash
 * (`2026.09.26-dd393fe`) or prerelease tags are not comparable, except that a
 * prerelease is older than the matching release.
 */
export const isCliUpdateAvailable = (
  installed: string | null | undefined,
  latest: string | null | undefined,
) => {
  const current = parseVersion(installed);
  const next = parseVersion(latest);
  if (!current || !next) {
    return false;
  }

  const length = Math.max(current.core.length, next.core.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (next.core[index] ?? 0) - (current.core[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }

  return current.prerelease !== null && next.prerelease === null;
};
