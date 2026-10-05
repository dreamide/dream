// What the host knows about the Git repositories it reads, and how long it
// may go on knowing it.
//
// Every git process the host starts goes through `run` here. Facts that do
// not change between reads (a project's repository root, the remote, the
// default branch) are read once and remembered for `stableTtlMs`. Reads of
// what does change (status, branches, worktrees) are shared between callers
// that ask at the same moment: a read joins one of the same kind that
// started at most `joinWindowMs` before it, which is what a refresh does
// when every panel asks at once.
//
// Staleness has one rule: a git command that may write (anything not known
// to be a read) forgets everything, before it starts and again when it
// ends, so no read begun before a write is handed to a caller after it.
// Changes made outside the host (an agent's shell, the user's terminal)
// are seen by the next read of volatile state; remembered facts catch up
// within `stableTtlMs`.
import path from "node:path";

export const getGitCommandErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Git is not available on PATH.";
  }

  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";

  return stderr || stdout || "Git command failed.";
};

export const isGitRepositoryError = (result) => {
  if (result.ok) {
    return false;
  }

  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    message.includes("not a git repository") ||
    message.includes("outside repository")
  );
};

const READ_ONLY_COMMANDS = new Set([
  "cat-file",
  "check-ref-format",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
]);

const positionals = (args) => args.filter((arg) => !arg.startsWith("-"));

/**
 * Whether `git <args>` only reads. Unknown commands count as writes: a
 * write taken for a read could hand out a stale answer, while a read taken
 * for a write only costs a cache.
 */
export const isReadOnlyGitCommand = (args) => {
  const [command = "", ...rest] = args;
  if (READ_ONLY_COMMANDS.has(command)) return true;
  if (command === "symbolic-ref") return positionals(rest).length <= 1;
  if (command === "branch") {
    return rest.every((arg) =>
      ["--show-current", "--list", "-l", "-a", "-r", "-v", "-vv"].includes(arg),
    );
  }
  if (command === "remote") {
    return rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url";
  }
  if (command === "config") {
    return ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(
      rest[0],
    );
  }
  if (command === "worktree") return rest[0] === "list";
  return false;
};

/**
 * @param {{
 *   run: (cwd: string, args: string[], options?: { allowFailure?: boolean }) =>
 *     Promise<{ ok: boolean, stdout: string, stderr: string, error?: unknown }>,
 *   now?: () => number,
 *   stableTtlMs?: number,
 *   joinWindowMs?: number,
 * }} options
 *   `run`: starts one git process (or, in tests, a recorded runner).
 */
export const createGitRepositoryContext = ({
  run,
  now = Date.now,
  stableTtlMs = 30_000,
  joinWindowMs = 100,
}) => {
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const facts = new Map();
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const reads = new Map();

  const forgetAll = () => {
    facts.clear();
    reads.clear();
  };

  /**
   * A stable fact, read once per `stableTtlMs`. A failed read is not kept,
   * nor a null one unless `keepNull`.
   */
  const remember = (key, read, { keepNull = true } = {}) => {
    const entry = facts.get(key);
    if (entry && now() - entry.at < stableTtlMs) return entry.promise;
    const promise = read();
    const next = { at: now(), promise };
    facts.set(key, next);
    promise.then(
      (value) => {
        if (value === null && !keepNull && facts.get(key) === next) {
          facts.delete(key);
        }
      },
      () => {
        if (facts.get(key) === next) facts.delete(key);
      },
    );
    return promise;
  };

  const joinable = (key) => {
    const entry = reads.get(key);
    if (!entry) return null;
    if (now() - entry.at > joinWindowMs) {
      reads.delete(key);
      return null;
    }
    return entry.promise;
  };

  const context = {
    /** Runs one git command, forgetting what a write may have changed. */
    async run(cwd, args, options) {
      if (isReadOnlyGitCommand(args)) return run(cwd, args, options);
      forgetAll();
      try {
        return await run(cwd, args, options);
      } finally {
        forgetAll();
      }
    },

    /** Forgets every fact and shared read, e.g. after a change git made. */
    forget: forgetAll,

    /**
     * A volatile read under `key`, shared with a read of the same key that
     * started within `joinWindowMs`.
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} read
     * @returns {Promise<T>}
     */
    share(key, read) {
      const existing = joinable(key);
      if (existing) return existing;
      const promise = read();
      const entry = { at: now(), promise };
      reads.set(key, entry);
      promise.catch(() => {
        if (reads.get(key) === entry) reads.delete(key);
      });
      return promise;
    },

    /** A shared read still joinable under `key`, without starting one. */
    joinable,

    /**
     * The top folder of the repository `projectPath` is in, or null when
     * it is in none (not remembered, so a new `git init` is seen at once).
     */
    repositoryRoot: (projectPath) =>
      remember(
        `root\0${path.resolve(projectPath)}`,
        async () => {
          const result = await run(
            projectPath,
            ["rev-parse", "--show-toplevel"],
            {
              allowFailure: true,
            },
          );
          if (result.ok) return result.stdout.trim();
          if (isGitRepositoryError(result)) return null;
          throw new Error(getGitCommandErrorMessage(result.error));
        },
        { keepNull: false },
      ),

    /** `origin` when there is one, else the first remote, else null. */
    remoteName: (repoRoot) =>
      remember(`remote\0${repoRoot}`, async () => {
        const result = await run(repoRoot, ["remote"], { allowFailure: true });
        if (!result.ok) return null;
        const remotes = result.stdout
          .split(/\r?\n/)
          .map((remote) => remote.trim())
          .filter(Boolean);
        if (remotes.length === 0) return null;
        return remotes.includes("origin") ? "origin" : remotes[0];
      }),

    /**
     * The branch work is based on: the remote's HEAD, else `main` or
     * `master` locally or on the remote; null when none of them exist.
     */
    defaultBranch: (repoRoot, remoteName) =>
      remember(`default\0${repoRoot}\0${remoteName ?? ""}`, async () => {
        if (remoteName) {
          const remoteHead = await run(
            repoRoot,
            [
              "symbolic-ref",
              "--quiet",
              "--short",
              `refs/remotes/${remoteName}/HEAD`,
            ],
            { allowFailure: true },
          );
          const head = remoteHead.ok ? remoteHead.stdout.trim() : "";
          if (head.startsWith(`${remoteName}/`)) {
            return head.slice(remoteName.length + 1);
          }
          if (head) return head;
        }

        const refExists = async (ref) =>
          (
            await run(repoRoot, ["show-ref", "--verify", "--quiet", ref], {
              allowFailure: true,
            })
          ).ok;
        for (const branchName of ["main", "master"]) {
          if (await refExists(`refs/heads/${branchName}`)) return branchName;
          if (
            remoteName &&
            (await refExists(`refs/remotes/${remoteName}/${branchName}`))
          ) {
            return branchName;
          }
        }
        return null;
      }),
  };
  return context;
};
