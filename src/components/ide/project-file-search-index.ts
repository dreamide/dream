export interface ProjectFileSearchIndexOptions {
  fetchFiles: () => Promise<string[]>;
}

/**
 * Mirrors the query normalization used by the @pierre/trees search box so the
 * paths we inject always satisfy the library's own substring filter.
 */
export const normalizeProjectSearchQuery = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.replace(/\\/g, "/").toLowerCase();
};

const getPathName = (path: string) => {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
};

const getSearchScore = (path: string, name: string, query: string) => {
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (path.startsWith(query)) {
    return 2;
  }
  if (name.includes(query)) {
    return 3;
  }
  if (path.includes(query)) {
    return 4;
  }
  return null;
};

interface IndexedPath {
  lowerName: string;
  lowerPath: string;
  path: string;
}

export class ProjectFileSearchIndex {
  readonly #fetchFiles: ProjectFileSearchIndexOptions["fetchFiles"];
  #generation = 0;
  #entries: IndexedPath[] | null = null;
  #inFlight: Promise<boolean> | null = null;

  constructor(options: ProjectFileSearchIndexOptions) {
    this.#fetchFiles = options.fetchFiles;
  }

  get generation() {
    return this.#generation;
  }

  get isLoaded() {
    return this.#entries !== null;
  }

  invalidate() {
    this.#generation += 1;
    this.#entries = null;
    this.#inFlight = null;
    return this.#generation;
  }

  ensureLoaded(): Promise<boolean> {
    if (this.#entries) {
      return Promise.resolve(true);
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }

    const requestGeneration = this.#generation;
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const files = await this.#fetchFiles();
        if (requestGeneration !== this.#generation) {
          return false;
        }
        const entries: IndexedPath[] = [];
        for (const file of files) {
          const path = file.replace(/\\/g, "/");
          const lowerPath = path.toLowerCase();
          entries.push({
            lowerName: getPathName(lowerPath),
            lowerPath,
            path,
          });
        }
        this.#entries = entries;
        return true;
      } catch {
        return false;
      } finally {
        if (this.#inFlight === request) {
          this.#inFlight = null;
        }
      }
    })();

    this.#inFlight = request;
    return request;
  }

  search(query: string, limit: number): string[] {
    const normalizedQuery = normalizeProjectSearchQuery(query);
    if (!normalizedQuery || !this.#entries || limit <= 0) {
      return [];
    }

    const matches: { path: string; score: number }[] = [];
    for (const entry of this.#entries) {
      const score = getSearchScore(
        entry.lowerPath,
        entry.lowerName,
        normalizedQuery,
      );
      if (score !== null) {
        matches.push({ path: entry.path, score });
      }
    }

    matches.sort(
      (a, b) =>
        a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

    return matches.slice(0, limit).map((match) => match.path);
  }
}
