import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

type WebglAddonLike = ITerminalAddon & {
  onContextLoss(listener: () => void): IDisposable;
};

type WebglCanvasLike = {
  getContext(
    contextId: "webgl2",
  ): { getExtension(name: "WEBGL_lose_context"): unknown } | null;
};

type WebglHostLike = Pick<Terminal, "loadAddon" | "options"> & {
  element?: {
    querySelectorAll(selector: string): ArrayLike<WebglCanvasLike>;
  };
};

export interface TerminalWebglRenderer extends IDisposable {
  /** True once disposed, explicitly or by falling back after context loss. */
  readonly disposed: boolean;
  /** True when the addon could not be created or loaded (WebGL2 unsupported). */
  readonly failed: boolean;
}

const WEBGL_CANVAS_SELECTOR = ".xterm-screen canvas";

const loseWebglContext = (canvas: WebglCanvasLike) => {
  try {
    // getContext returns the existing context for a canvas that already has one.
    const extension = canvas
      .getContext("webgl2")
      ?.getExtension("WEBGL_lose_context");
    if (
      extension &&
      typeof extension === "object" &&
      "loseContext" in extension &&
      typeof extension.loseContext === "function"
    ) {
      extension.loseContext();
    }
  } catch {
    // Losing a context is best effort; a 2D canvas or a destroyed one throws.
  }
};

export function attachTerminalWebglRenderer(
  terminal: WebglHostLike,
  createAddon: () => WebglAddonLike,
): TerminalWebglRenderer {
  let addon: WebglAddonLike | null = null;
  let lossSubscription: IDisposable | null = null;
  let disposed = false;
  let failed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lossSubscription?.dispose();
    lossSubscription = null;
    if (!addon) return;

    // Capture before dispose: the addon removes its canvas from the DOM.
    const canvases = Array.from(
      terminal.element?.querySelectorAll(WEBGL_CANVAS_SELECTOR) ?? [],
    );

    // @xterm/addon-webgl 0.19.0 never registers its CursorBlinkStateManager,
    // so its blink interval outlives dispose() and retains the renderer, the
    // GL context and the whole Terminal. Turning cursorBlink off makes the
    // addon clear that manager while it is still listening to option changes;
    // restoring it afterwards hands blinking back to the DOM renderer.
    const cursorBlink = terminal.options.cursorBlink;
    terminal.options.cursorBlink = false;
    try {
      addon.dispose();
    } finally {
      addon = null;
      terminal.options.cursorBlink = cursorBlink;
    }

    // The addon never calls loseContext. Leaked contexts count toward
    // Chromium's per-renderer cap and get live terminals' contexts killed.
    for (const canvas of canvases) {
      loseWebglContext(canvas);
    }
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
    failed = true;
    fallback(error);
  }

  return {
    dispose,
    get disposed() {
      return disposed;
    },
    get failed() {
      return failed;
    },
  };
}
