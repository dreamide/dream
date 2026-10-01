import { describe, expect, it, vi } from "vitest";
import { attachTerminalWebglRenderer } from "./terminal-webgl";

const createCanvas = () => {
  const loseContext = vi.fn();
  const canvas = {
    getContext: vi.fn(() => ({
      getExtension: vi.fn(() => ({ loseContext })),
    })),
  };
  return { canvas, loseContext };
};

const createTerminal = (canvases: ReturnType<typeof createCanvas>[] = []) => {
  const options = { cursorBlink: true };
  const terminal = {
    loadAddon: vi.fn(),
    options,
    element: {
      querySelectorAll: vi.fn((selector: string) => {
        expect(selector).toBe(".xterm-screen canvas");
        // Mirror the addon removing its canvas on dispose: only the live
        // query returns the canvases, so dispose must capture them first.
        return canvases.map(({ canvas }) => canvas);
      }),
    },
  };
  return terminal;
};

const createAddon = (
  terminal: ReturnType<typeof createTerminal>,
  { throwOnLoad = false } = {},
) => {
  let contextLossListener: (() => void) | null = null;
  const cursorBlinkDuringDispose: boolean[] = [];
  const addon = {
    activate: vi.fn(),
    dispose: vi.fn(() => {
      cursorBlinkDuringDispose.push(terminal.options.cursorBlink);
      if (terminal.element) {
        terminal.element.querySelectorAll = vi.fn(() => []);
      }
    }),
    onContextLoss: vi.fn((listener: () => void) => {
      contextLossListener = listener;
      return { dispose: vi.fn() };
    }),
  };
  if (throwOnLoad) {
    terminal.loadAddon.mockImplementation(() => {
      throw new Error("WebGL2 not supported");
    });
  }
  return {
    addon,
    cursorBlinkDuringDispose,
    loseContext: () => contextLossListener?.(),
  };
};

describe("attachTerminalWebglRenderer", () => {
  it("clears the addon blink manager and releases GL contexts on dispose", () => {
    const first = createCanvas();
    const second = createCanvas();
    const terminal = createTerminal([first, second]);
    const { addon, cursorBlinkDuringDispose } = createAddon(terminal);

    const renderer = attachTerminalWebglRenderer(terminal, () => addon);
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);
    expect(renderer.failed).toBe(false);
    expect(renderer.disposed).toBe(false);

    renderer.dispose();

    expect(renderer.disposed).toBe(true);
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    // cursorBlink is off while the addon disposes so it clears its
    // CursorBlinkStateManager, then restored for the DOM renderer.
    expect(cursorBlinkDuringDispose).toEqual([false]);
    expect(terminal.options.cursorBlink).toBe(true);
    expect(first.loseContext).toHaveBeenCalledTimes(1);
    expect(second.loseContext).toHaveBeenCalledTimes(1);
  });

  it("restores cursorBlink even when the addon throws on dispose", () => {
    const terminal = createTerminal([createCanvas()]);
    const { addon } = createAddon(terminal);
    addon.dispose.mockImplementation(() => {
      throw new Error("boom");
    });

    const renderer = attachTerminalWebglRenderer(terminal, () => addon);
    expect(() => renderer.dispose()).toThrow("boom");
    expect(terminal.options.cursorBlink).toBe(true);
  });

  it("is idempotent", () => {
    const canvas = createCanvas();
    const terminal = createTerminal([canvas]);
    const { addon } = createAddon(terminal);

    const renderer = attachTerminalWebglRenderer(terminal, () => addon);
    renderer.dispose();
    renderer.dispose();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(canvas.loseContext).toHaveBeenCalledTimes(1);
  });

  it("falls back on context loss without marking the renderer failed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = createCanvas();
    const terminal = createTerminal([canvas]);
    const { addon, loseContext } = createAddon(terminal);

    const renderer = attachTerminalWebglRenderer(terminal, () => addon);
    loseContext();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(canvas.loseContext).toHaveBeenCalledTimes(1);
    expect(terminal.options.cursorBlink).toBe(true);
    // Context loss is transient: a later activation may attach again.
    expect(renderer.disposed).toBe(true);
    expect(renderer.failed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("marks the renderer failed when the addon cannot load", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const terminal = createTerminal();
    const { addon } = createAddon(terminal, { throwOnLoad: true });

    const renderer = attachTerminalWebglRenderer(terminal, () => addon);

    expect(renderer.failed).toBe(true);
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.options.cursorBlink).toBe(true);
    warn.mockRestore();
  });

  it("tolerates a terminal without a DOM element", () => {
    const terminal = {
      loadAddon: vi.fn(),
      options: { cursorBlink: false },
    };
    const { addon } = createAddon(
      terminal as unknown as ReturnType<typeof createTerminal>,
    );

    const renderer = attachTerminalWebglRenderer(terminal, () => addon);
    expect(() => renderer.dispose()).not.toThrow();
    expect(terminal.options.cursorBlink).toBe(false);
  });
});
