export type ProjectDirectoryEntryKind = "directory" | "file" | "symlink";

export interface ProjectDirectoryEntry {
  kind: ProjectDirectoryEntryKind;
  path: string;
}

export interface ProjectDirectoryResponse {
  directory: string;
  entries: ProjectDirectoryEntry[];
}

export interface ProjectDirectoryLoadContext {
  generation: number;
}

export interface ProjectDirectoryLoaderOptions {
  fetchDirectory: (directory: string) => Promise<ProjectDirectoryResponse>;
  onDirectoryError?: (
    directory: string,
    error: unknown,
    context: ProjectDirectoryLoadContext,
  ) => void;
  onDirectoryLoaded?: (
    response: ProjectDirectoryResponse,
    context: ProjectDirectoryLoadContext,
  ) => void;
}

export const normalizeProjectDirectory = (directory: string) => {
  const normalized = directory
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
  return normalized || ".";
};

export const toProjectTreePath = (entry: ProjectDirectoryEntry) =>
  entry.kind === "directory"
    ? `${entry.path.replace(/\/+$/, "")}/`
    : entry.path;

export const getProjectFileAncestorDirectories = (filePath: string) => {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const directories: string[] = [];

  for (let index = 1; index < parts.length; index += 1) {
    directories.push(parts.slice(0, index).join("/"));
  }

  return directories;
};

export const resolveSelectedProjectFile = (
  currentFile: string | null,
  selectedTreePath: string | null,
  knownFiles: ReadonlySet<string>,
) =>
  selectedTreePath && knownFiles.has(selectedTreePath)
    ? selectedTreePath
    : currentFile;

export class ProjectDirectoryLoader {
  readonly #fetchDirectory: ProjectDirectoryLoaderOptions["fetchDirectory"];
  readonly #onDirectoryError?: ProjectDirectoryLoaderOptions["onDirectoryError"];
  readonly #onDirectoryLoaded?: ProjectDirectoryLoaderOptions["onDirectoryLoaded"];
  #generation = 0;
  readonly #loadedDirectories = new Set<string>();
  readonly #inFlightDirectories = new Map<
    string,
    Promise<ProjectDirectoryResponse | null>
  >();
  readonly #directoryEntries = new Map<string, ProjectDirectoryEntry[]>();
  readonly #knownDirectories = new Set<string>(["."]);
  readonly #knownFiles = new Set<string>();
  readonly #expandedDirectories = new Map<string, boolean>();

  constructor(options: ProjectDirectoryLoaderOptions) {
    this.#fetchDirectory = options.fetchDirectory;
    this.#onDirectoryError = options.onDirectoryError;
    this.#onDirectoryLoaded = options.onDirectoryLoaded;
  }

  get generation() {
    return this.#generation;
  }

  get knownDirectories(): ReadonlySet<string> {
    return this.#knownDirectories;
  }

  get knownFiles(): ReadonlySet<string> {
    return this.#knownFiles;
  }

  isLoaded(directory: string) {
    return this.#loadedDirectories.has(normalizeProjectDirectory(directory));
  }

  isLoading(directory: string) {
    return this.#inFlightDirectories.has(normalizeProjectDirectory(directory));
  }

  invalidate() {
    this.#generation += 1;
    this.#loadedDirectories.clear();
    this.#inFlightDirectories.clear();
    this.#directoryEntries.clear();
    this.#knownDirectories.clear();
    this.#knownDirectories.add(".");
    this.#knownFiles.clear();
    this.#expandedDirectories.clear();
    return this.#generation;
  }

  /**
   * Registers files discovered outside of a directory listing (e.g. search
   * results injected into the tree) so that revealing them walks their
   * ancestors and expanding those ancestors later loads the full listing.
   * Directories are marked as known but not loaded.
   */
  registerPaths(filePaths: Iterable<string>) {
    for (const filePath of filePaths) {
      const normalizedFilePath = filePath.replace(/\\/g, "/");
      if (!normalizedFilePath || normalizedFilePath.endsWith("/")) {
        continue;
      }
      for (const directory of getProjectFileAncestorDirectories(
        normalizedFilePath,
      )) {
        this.#knownDirectories.add(directory);
      }
      this.#knownFiles.add(normalizedFilePath);
    }
  }

  load(directory: string): Promise<ProjectDirectoryResponse | null> {
    const normalizedDirectory = normalizeProjectDirectory(directory);
    const cachedEntries = this.#directoryEntries.get(normalizedDirectory);
    if (this.#loadedDirectories.has(normalizedDirectory) && cachedEntries) {
      return Promise.resolve({
        directory: normalizedDirectory,
        entries: cachedEntries,
      });
    }

    const existingRequest = this.#inFlightDirectories.get(normalizedDirectory);
    if (existingRequest) {
      return existingRequest;
    }

    const requestGeneration = this.#generation;
    let request!: Promise<ProjectDirectoryResponse | null>;
    request = (async () => {
      try {
        const response = await this.#fetchDirectory(normalizedDirectory);
        if (requestGeneration !== this.#generation) {
          return null;
        }

        const responseDirectory = normalizeProjectDirectory(response.directory);
        if (responseDirectory !== normalizedDirectory) {
          throw new Error(
            `Directory response mismatch: expected ${normalizedDirectory}, received ${responseDirectory}.`,
          );
        }

        this.#directoryEntries.set(normalizedDirectory, response.entries);
        this.#loadedDirectories.add(normalizedDirectory);
        for (const entry of response.entries) {
          if (entry.kind === "directory") {
            this.#knownDirectories.add(normalizeProjectDirectory(entry.path));
          } else {
            this.#knownFiles.add(entry.path);
          }
        }
        this.#onDirectoryLoaded?.(response, {
          generation: requestGeneration,
        });
        return response;
      } catch (error) {
        if (requestGeneration === this.#generation) {
          this.#onDirectoryError?.(normalizedDirectory, error, {
            generation: requestGeneration,
          });
        }
        throw error;
      } finally {
        if (this.#inFlightDirectories.get(normalizedDirectory) === request) {
          this.#inFlightDirectories.delete(normalizedDirectory);
        }
      }
    })();

    this.#inFlightDirectories.set(normalizedDirectory, request);
    return request;
  }

  async syncExpandedDirectories(expandedDirectories: Iterable<string>) {
    const expanded = new Set(
      [...expandedDirectories].map(normalizeProjectDirectory),
    );
    const loads: Promise<ProjectDirectoryResponse | null>[] = [];

    for (const directory of this.#knownDirectories) {
      if (directory === ".") {
        continue;
      }

      const isExpanded = expanded.has(directory);
      const wasExpanded = this.#expandedDirectories.get(directory) ?? false;
      this.#expandedDirectories.set(directory, isExpanded);
      if (isExpanded && !wasExpanded) {
        loads.push(this.load(directory));
      }
    }

    await Promise.allSettled(loads);
  }

  async revealFile(
    filePath: string,
    callbacks: {
      expandDirectory: (directory: string) => void;
      revealFile: (filePath: string) => void;
    },
  ) {
    const normalizedFilePath = filePath.replace(/\\/g, "/");
    if (!(await this.load("."))) {
      return false;
    }

    for (const directory of getProjectFileAncestorDirectories(
      normalizedFilePath,
    )) {
      if (!this.#knownDirectories.has(directory)) {
        return false;
      }
      if (!(await this.load(directory))) {
        return false;
      }
      callbacks.expandDirectory(directory);
    }

    if (!this.#knownFiles.has(normalizedFilePath)) {
      return false;
    }

    callbacks.revealFile(normalizedFilePath);
    return true;
  }
}
