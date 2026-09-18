import { resolvePersistedProjectPath } from "../../persisted-state.js";
import { createGraphRunner } from "./engine.js";
import { createProviderGraphExecutor } from "./executor.js";
import { createGraphRepository } from "./repository.js";

/**
 * Process-wide graph runtime. Lives in the Electron main process so runs
 * survive renderer reloads; the renderer only observes via IPC events and
 * the HTTP API.
 */

let repository = null;
let runner = null;

export const getGraphRepository = () => {
  repository ??= createGraphRepository();
  return repository;
};

export const getGraphRunner = () => {
  runner ??= createGraphRunner({
    executor: createProviderGraphExecutor(),
    getProjectPath: (projectId) =>
      resolvePersistedProjectPath({ projectId }) ?? null,
    repository: getGraphRepository(),
  });
  return runner;
};

/** Called once at startup: orphaned `running` runs become resumable failures. */
export const initializeGraphRuntime = () => {
  try {
    const recovered = getGraphRunner().recoverInterruptedRuns();
    if (recovered > 0) {
      console.log(`[graphs] marked ${recovered} interrupted run(s) as failed`);
    }
  } catch (error) {
    console.error("[graphs] failed to initialize runtime:", error);
  }
};

export const shutdownGraphRuntime = async () => {
  if (!runner) {
    return;
  }
  runner.stopAll();
};
