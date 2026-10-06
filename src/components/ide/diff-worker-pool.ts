import type { HighlighterTypes } from "@pierre/diffs";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useState } from "react";

/**
 * Oniguruma WASM, not Pierre's default JS regex engine: the JS engine can
 * backtrack catastrophically on some grammars. Pierre's shared highlighter is a
 * first-caller-wins singleton, so the main-thread fallback must pass this too.
 */
export const DIFF_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

export const DIFF_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

// Keep workers across short panel closures instead of re-spawning them.
const IDLE_TTL_MS = 30_000;

type PoolEntry = {
  readonly pool: WorkerPoolManager;
  consumers: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

let shared: PoolEntry | undefined;

const workersSupported = () => typeof Worker !== "undefined";

const getPoolSize = () => {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
};

const acquire = (): PoolEntry => {
  shared ??= {
    pool: new WorkerPoolManager(
      {
        workerFactory: () => new DiffsWorker(),
        poolSize: getPoolSize(),
        totalASTLRUCacheSize: 240,
      },
      {
        // Pool options override each FileDiff's own options, so these must
        // match what the viewer would otherwise render on the main thread.
        theme: DIFF_THEMES,
        lineDiffType: "none",
        preferredHighlighter: DIFF_HIGHLIGHTER,
        tokenizeMaxLineLength: 1_000,
      },
    ),
    consumers: 0,
    idleTimer: undefined,
  };
  clearTimeout(shared.idleTimer);
  shared.idleTimer = undefined;
  shared.consumers += 1;
  return shared;
};

const release = (entry: PoolEntry) => {
  entry.consumers -= 1;
  if (entry.consumers > 0) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    entry.pool.terminate();
    if (shared === entry) shared = undefined;
  }, IDLE_TTL_MS);
};

const isSettled = (pool: WorkerPoolManager) =>
  pool.isInitialized() || !pool.isWorkingPool();

export type DiffWorkerPoolState = {
  /** The pool to provide to Pierre, or undefined to highlight on the main thread. */
  pool: WorkerPoolManager | undefined;
  /** True once the pool has started or failed (and fallen back). */
  ready: boolean;
};

/**
 * Share one diff-highlighting worker pool across every mounted viewer.
 * Waits for initialization before reporting ready, so a FileDiff never mounts
 * against a cold pool and paints a blank first render.
 */
export const useDiffWorkerPool = (enabled: boolean): DiffWorkerPoolState => {
  const [state, setState] = useState<DiffWorkerPoolState>(() => {
    if (!workersSupported()) return { pool: undefined, ready: true };
    const pool = shared?.pool;
    return pool && isSettled(pool)
      ? { pool, ready: true }
      : { pool: undefined, ready: false };
  });

  useEffect(() => {
    if (!enabled || !workersSupported()) return;
    const entry = acquire();
    const { pool } = entry;
    let active = true;
    const settle = () => {
      if (!active) return;
      setState((current) =>
        current.pool === pool && current.ready
          ? current
          : { pool, ready: true },
      );
    };
    if (isSettled(pool)) {
      settle();
    } else {
      // A failed pool reports isWorkingPool() === false; Pierre then falls
      // back to its main-thread highlighter, so failure still means ready.
      pool.initialize().then(settle, settle);
    }
    return () => {
      active = false;
      release(entry);
    };
  }, [enabled]);

  return state;
};
