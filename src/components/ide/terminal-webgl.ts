import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

type WebglAddonLike = ITerminalAddon & {
  onContextLoss(listener: () => void): IDisposable;
};

export function attachTerminalWebglRenderer(
  terminal: Pick<Terminal, "loadAddon">,
  createAddon: () => WebglAddonLike,
): IDisposable {
  let addon: WebglAddonLike | null = null;
  let lossSubscription: IDisposable | null = null;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lossSubscription?.dispose();
    lossSubscription = null;
    addon?.dispose();
    addon = null;
  };

  const fallback = (error: unknown) => {
    if (disposed) return;
    console.warn(
      "[terminal] WebGL renderer unavailable, using DOM renderer",
      error,
    );
    dispose();
  };

  try {
    addon = createAddon();
    lossSubscription = addon.onContextLoss(() => {
      fallback(new Error("WebGL context lost"));
    });
    terminal.loadAddon(addon);
  } catch (error) {
    fallback(error);
  }

  return { dispose };
}
