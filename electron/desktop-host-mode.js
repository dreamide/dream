// Which host mode a desktop launch ends up in.
//
//   detached    the default: the host running on this desktop's database,
//               whoever started it, or one the desktop starts and stops
//               (desktop-host.js)
//   in-process  the host inside Electron's main process (the escape hatch,
//               and the only choice while the workspace shares the state
//               database's writer)
//
// DREAM_HOST_MODE (`auto` or `in-process`) chooses; `auto` and `desktop`,
// like leaving it unset, choose the default. The desktop always has a host
// of its own: a desktop with none (the former `remote` mode) is not offered.

const ENV_MODES = new Set(["auto", "desktop", "in-process"]);

/**
 * The host mode of this launch.
 * @param {{ envMode?: string | null, workspaceSeparate: boolean }} options
 *   `workspaceSeparate`: false while the workspace still lives in the state
 *   database; then only an in-process host can share its one writer.
 * @returns {{ mode: "detached" | "in-process", reason: string }}
 */
export function resolveDesktopHostMode({ envMode, workspaceSeparate }) {
  const requested = envMode?.trim() || "";
  if (requested === "service") {
    throw new Error(
      "DREAM_HOST_MODE=service was removed: run `dream-host serve` on this desktop's data and the desktop attaches to it.",
    );
  }
  if (requested === "remote") {
    throw new Error(
      "DREAM_HOST_MODE=remote was removed: the desktop always runs a host of its own. Add other hosts in Settings > Hosts.",
    );
  }
  if (requested && !ENV_MODES.has(requested)) {
    throw new Error("DREAM_HOST_MODE must be auto or in-process.");
  }
  if (requested === "in-process") {
    return { mode: requested, reason: "DREAM_HOST_MODE" };
  }
  // The workspace still in the state database: its one writer is shared
  // with the host's catalog, which only a host in this process can do.
  if (!workspaceSeparate) {
    return { mode: "in-process", reason: "shared-writer" };
  }
  return { mode: "detached", reason: "default" };
}
