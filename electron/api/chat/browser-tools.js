import { createCustomMcpServer } from "ai-sdk-provider-claude-code";
import { z } from "zod";
import { getBrowserBridge } from "../browser-bridge.js";
import {
  buildEvaluateScript,
  buildFocusForTypingScript,
  buildLocateForPointerScript,
  buildProgrammaticClickScript,
  buildScrollScript,
  buildSelectOptionScript,
  buildSnapshotScript,
  buildWaitForScript,
  DEFAULT_SNAPSHOT_MAX_CHARS,
} from "./browser-page-scripts.js";

/**
 * Agent tools for Dream's built-in browser panel.
 *
 * Exposed to Claude as an in-process MCP server named `dream-browser`, so the
 * model sees tools like `mcp__dream-browser__browser_navigate`. Everything
 * here drives the same `<webview>` tabs the user sees.
 */

export const BROWSER_MCP_SERVER_NAME = "dream-browser";

const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_JPEG_QUALITY = 80;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 10_000;
const WAIT_FOR_MAX_TIMEOUT_MS = 60_000;
const KEY_EVENT_DELAY_MS = 8;

const READ_ONLY_TOOL_NAMES = [
  "browser_list_tabs",
  "browser_snapshot",
  "browser_screenshot",
  "browser_console_logs",
  "browser_wait_for",
];

/**
 * Fully-qualified names of tools that never change page or app state. These
 * are pre-allowed (like Read/Glob) so an agent can look at the page without a
 * permission prompt; every mutating tool still goes through `canUseTool`.
 */
export const BROWSER_READ_ONLY_TOOL_IDS = READ_ONLY_TOOL_NAMES.map(
  (name) => `mcp__${BROWSER_MCP_SERVER_NAME}__${name}`,
);

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const textResult = (value) => ({
  content: [
    {
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      type: "text",
    },
  ],
});

const errorResult = (message) => ({
  content: [{ text: message, type: "text" }],
  isError: true,
});

const toErrorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const withErrors = (handler) => async (args, extra) => {
  try {
    return await handler(args ?? {}, extra);
  } catch (error) {
    return errorResult(toErrorMessage(error));
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describeLoadFailure = (failure) =>
  failure
    ? `Navigation problem: ${failure.errorDescription ?? "unknown error"}${
        failure.errorCode ? ` (code ${failure.errorCode})` : ""
      }${failure.url ? ` for ${failure.url}` : ""}`
    : null;

const guestSummary = (guest, tabId) => ({
  canGoBack:
    guest.navigationHistory?.canGoBack?.() ?? guest.canGoBack?.() ?? false,
  canGoForward:
    guest.navigationHistory?.canGoForward?.() ??
    guest.canGoForward?.() ??
    false,
  loading: guest.isLoading(),
  tabId,
  title: guest.getTitle(),
  url: guest.getURL(),
});

export const normalizeAgentUrl = (input) => {
  const value = String(input ?? "").trim();
  if (!value) {
    return null;
  }
  // A real scheme is followed by "//" (http, file, chrome...) or is one of
  // the schemeless-authority forms. Plain "localhost:3000" is host:port.
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^(about|blob|data|javascript|mailto|view-source):/i.test(value)
  ) {
    return value;
  }
  if (
    /^localhost(:\d+)?([/?#]|$)/i.test(value) ||
    /^\d{1,3}(\.\d{1,3}){3}/.test(value)
  ) {
    return `http://${value}`;
  }
  return `https://${value}`;
};

// ---------------------------------------------------------------------------
// Keyboard helpers
// ---------------------------------------------------------------------------

const KEY_ALIASES = {
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "Backspace",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  left: "Left",
  pagedown: "PageDown",
  pageup: "PageUp",
  return: "Return",
  right: "Right",
  space: "Space",
  tab: "Tab",
  up: "Up",
};

export const parseKeyCombo = (combo) => {
  const parts = String(combo ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('A key is required, e.g. "Enter" or "Control+A".');
  }
  const modifiers = [];
  let key = parts[parts.length - 1];
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") modifiers.push("control");
    else if (lower === "shift") modifiers.push("shift");
    else if (lower === "alt" || lower === "option") modifiers.push("alt");
    else if (
      lower === "meta" ||
      lower === "cmd" ||
      lower === "command" ||
      lower === "super"
    )
      modifiers.push("meta");
    else throw new Error(`Unknown modifier "${part}".`);
  }
  const alias = KEY_ALIASES[key.toLowerCase()];
  if (alias) {
    key = alias;
  } else if (
    key.length === 1 &&
    modifiers.length === 0 &&
    /[A-Z]/.test(key) &&
    key !== key.toLowerCase()
  ) {
    modifiers.push("shift");
  }
  return { key, modifiers };
};

const sendKey = async (guest, combo) => {
  const { key, modifiers } = parseKeyCombo(combo);
  const isPrintable = key.length === 1;
  guest.sendInputEvent({ keyCode: key, modifiers, type: "keyDown" });
  if (isPrintable || key === "Return" || key === "Space" || key === "Tab") {
    const char =
      key === "Return"
        ? "\r"
        : key === "Space"
          ? " "
          : key === "Tab"
            ? "\t"
            : key;
    guest.sendInputEvent({ keyCode: char, modifiers, type: "char" });
  }
  guest.sendInputEvent({ keyCode: key, modifiers, type: "keyUp" });
  await sleep(KEY_EVENT_DELAY_MS);
};

const typeText = async (guest, text) => {
  for (const char of String(text)) {
    if (char === "\n") {
      await sendKey(guest, "Enter");
      continue;
    }
    guest.sendInputEvent({ keyCode: char, type: "keyDown" });
    guest.sendInputEvent({ keyCode: char, type: "char" });
    guest.sendInputEvent({ keyCode: char, type: "keyUp" });
    await sleep(KEY_EVENT_DELAY_MS);
  }
};

const clickAt = async (
  guest,
  x,
  y,
  { button = "left", clickCount = 1 } = {},
) => {
  const zoom = guest.getZoomFactor?.() ?? 1;
  const px = Math.round(x * zoom);
  const py = Math.round(y * zoom);
  guest.sendInputEvent({ type: "mouseMove", x: px, y: py });
  await sleep(KEY_EVENT_DELAY_MS);
  for (let index = 1; index <= clickCount; index += 1) {
    guest.sendInputEvent({
      button,
      clickCount: index,
      type: "mouseDown",
      x: px,
      y: py,
    });
    guest.sendInputEvent({
      button,
      clickCount: index,
      type: "mouseUp",
      x: px,
      y: py,
    });
  }
  await sleep(KEY_EVENT_DELAY_MS);
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const tabIdField = z
  .string()
  .optional()
  .describe(
    "Target tab id from browser_list_tabs. Defaults to the active browser tab.",
  );

const locatorFields = {
  ref: z
    .string()
    .optional()
    .describe('Element ref from browser_snapshot, e.g. "e12". Preferred.'),
  selector: z
    .string()
    .optional()
    .describe("CSS selector, used when no ref is given."),
};

export const createBrowserToolDefinitions = ({ bridge, projectId }) => {
  const requireBridge = () => {
    if (!bridge) {
      throw new Error("The Dream browser is not available in this session.");
    }
    return bridge;
  };

  /** Ask the renderer which tab is active (and make sure the panel exists). */
  const resolveTabId = async (tabId) => {
    if (tabId) {
      return tabId;
    }
    const result = await requireBridge().sendCommand(projectId, "list-tabs");
    const active = result?.tabs?.find((tab) => tab.active) ?? result?.tabs?.[0];
    if (!active) {
      throw new Error(
        "No browser tab is open. Use browser_open_tab to open one first.",
      );
    }
    return active.id;
  };

  /**
   * Make sure the tab is visible and its guest is mounted, then return the
   * live guest webContents. Opens the panel / activates the tab as needed.
   */
  const acquireGuest = async (tabId) => {
    const resolvedTabId = await resolveTabId(tabId);
    const existing = requireBridge().getGuest(projectId, resolvedTabId);
    if (existing) {
      return { guest: existing, tabId: resolvedTabId };
    }
    const shown = await requireBridge().sendCommand(projectId, "show-tab", {
      tabId: resolvedTabId,
    });
    if (!shown?.url) {
      throw new Error(
        `Tab ${resolvedTabId} has no URL yet. Use browser_navigate with a url to load a page.`,
      );
    }
    const guest = await requireBridge().waitForGuest(projectId, resolvedTabId);
    return { guest, tabId: resolvedTabId };
  };

  const settleAndSummarize = async (guest, tabId, { extra } = {}) => {
    const failure = await requireBridge().waitForLoad(guest);
    const summary = guestSummary(guest, tabId);
    const problem = describeLoadFailure(failure);
    return textResult({
      ...summary,
      ...(problem ? { warning: problem } : {}),
      ...(extra ?? {}),
    });
  };

  const locateForPointer = async (guest, locator) => {
    const located = await guest.executeJavaScript(
      buildLocateForPointerScript(locator),
      true,
    );
    if (!located || located.error) {
      throw new Error(located?.error ?? "Could not locate element.");
    }
    return located;
  };

  return {
    browser_list_tabs: {
      annotations: { readOnlyHint: true },
      description:
        "List the tabs open in Dream's built-in browser panel for this project, with ids, URLs, titles, and which one is active.",
      handler: withErrors(async () => {
        const result = await requireBridge().sendCommand(
          projectId,
          "list-tabs",
        );
        return textResult({
          panelOpen: Boolean(result?.panelOpen),
          tabs: (result?.tabs ?? []).map((tab) => ({
            ...tab,
            mounted: Boolean(requireBridge().getGuest(projectId, tab.id)),
          })),
        });
      }),
      inputSchema: z.object({}),
    },

    browser_open_tab: {
      description:
        "Open a new tab in Dream's built-in browser panel and load a URL. Opens the panel if it is hidden and makes the new tab active. Returns the tab id; pass it to other browser tools. Use this to preview a local dev server (e.g. http://localhost:3000) or any website.",
      handler: withErrors(async ({ url }) => {
        const normalized = normalizeAgentUrl(url);
        if (!normalized) {
          return errorResult("A url is required.");
        }
        const opened = await requireBridge().sendCommand(
          projectId,
          "open-tab",
          {
            url: normalized,
          },
        );
        const tabId = opened?.tabId;
        if (!tabId) {
          return errorResult("The browser panel did not report a new tab.");
        }
        const guest = await requireBridge().waitForGuest(projectId, tabId);
        return settleAndSummarize(guest, tabId, {
          extra: { reusedEmptyTab: Boolean(opened?.reused) },
        });
      }),
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe("URL to load, e.g. http://localhost:3000/"),
      }),
    },

    browser_navigate: {
      description:
        "Navigate a browser tab to a URL and wait for the page to finish loading. Defaults to the active tab.",
      handler: withErrors(async ({ tabId, url }) => {
        const normalized = normalizeAgentUrl(url);
        if (!normalized) {
          return errorResult("A url is required.");
        }
        const resolvedTabId = await resolveTabId(tabId);
        const existing = requireBridge().getGuest(projectId, resolvedTabId);
        if (existing) {
          // Mounted already: bring it to front and drive the guest directly.
          // The renderer's did-navigate listeners keep tab state in sync.
          await requireBridge().sendCommand(projectId, "show-tab", {
            tabId: resolvedTabId,
          });
          void existing.loadURL(normalized).catch(() => {
            // did-fail-load reports the failure through waitForLoad.
          });
          return settleAndSummarize(existing, resolvedTabId);
        }
        // The tab is not mounted (empty URL or hidden panel): let the renderer
        // set the URL, which mounts the <webview> and starts the load itself.
        await requireBridge().sendCommand(projectId, "show-tab", {
          tabId: resolvedTabId,
          url: normalized,
        });
        const guest = await requireBridge().waitForGuest(
          projectId,
          resolvedTabId,
        );
        return settleAndSummarize(guest, resolvedTabId);
      }),
      inputSchema: z.object({
        tabId: tabIdField,
        url: z.string().min(1).describe("URL to load."),
      }),
    },

    browser_go_back: {
      description:
        "Go back one entry in a browser tab's history and wait for the load.",
      handler: withErrors(async ({ tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        const canGoBack =
          guest.navigationHistory?.canGoBack?.() ?? guest.canGoBack?.();
        if (!canGoBack) {
          return errorResult("This tab has no previous page.");
        }
        if (guest.navigationHistory?.goBack) guest.navigationHistory.goBack();
        else guest.goBack();
        return settleAndSummarize(guest, resolvedTabId);
      }),
      inputSchema: z.object({ tabId: tabIdField }),
    },

    browser_go_forward: {
      description:
        "Go forward one entry in a browser tab's history and wait for the load.",
      handler: withErrors(async ({ tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        const canGoForward =
          guest.navigationHistory?.canGoForward?.() ?? guest.canGoForward?.();
        if (!canGoForward) {
          return errorResult("This tab has no next page.");
        }
        if (guest.navigationHistory?.goForward)
          guest.navigationHistory.goForward();
        else guest.goForward();
        return settleAndSummarize(guest, resolvedTabId);
      }),
      inputSchema: z.object({ tabId: tabIdField }),
    },

    browser_reload: {
      description:
        "Reload a browser tab and wait for the load. Set ignoreCache to bypass the HTTP cache.",
      handler: withErrors(async ({ ignoreCache, tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        if (ignoreCache) guest.reloadIgnoringCache();
        else guest.reload();
        return settleAndSummarize(guest, resolvedTabId);
      }),
      inputSchema: z.object({
        ignoreCache: z.boolean().optional(),
        tabId: tabIdField,
      }),
    },

    browser_activate_tab: {
      description:
        "Switch the browser panel to a tab so it is visible and interactive.",
      handler: withErrors(async ({ tabId }) => {
        const result = await requireBridge().sendCommand(
          projectId,
          "show-tab",
          {
            tabId,
          },
        );
        return textResult(result ?? { tabId });
      }),
      inputSchema: z.object({ tabId: z.string().min(1) }),
    },

    browser_close_tab: {
      description:
        "Close a browser tab. Closing the last tab leaves an empty tab in the panel.",
      handler: withErrors(async ({ tabId }) => {
        const result = await requireBridge().sendCommand(
          projectId,
          "close-tab",
          {
            tabId,
          },
        );
        return textResult(result ?? { closed: tabId });
      }),
      inputSchema: z.object({ tabId: z.string().min(1) }),
    },

    browser_snapshot: {
      annotations: { readOnlyHint: true },
      description:
        'Get a compact text outline of the visible page: one line per element as "[ref] role \\"name\\" attrs". Use the refs with browser_click, browser_type, browser_select_option and browser_scroll. Much cheaper than a screenshot; prefer it for reading and interacting. Refs reset whenever the page navigates.',
      handler: withErrors(async ({ maxChars, selector, tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        await requireBridge().waitForLoad(guest, { timeoutMs: 5_000 });
        const snapshot = await guest.executeJavaScript(
          buildSnapshotScript({ maxChars, selector }),
          true,
        );
        if (!snapshot || snapshot.error) {
          return errorResult(snapshot?.error ?? "Snapshot failed.");
        }
        const header = [
          `tab: ${resolvedTabId}`,
          `url: ${snapshot.url}`,
          `title: ${snapshot.title}`,
          `viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}, scrollY ${snapshot.scroll.y}/${snapshot.scroll.height}`,
          snapshot.truncated
            ? `note: outline truncated at ${maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS} chars; pass a selector or larger maxChars for more`
            : null,
          "",
        ].filter((line) => line !== null);
        return textResult([...header, ...snapshot.lines].join("\n"));
      }),
      inputSchema: z.object({
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .optional()
          .describe(
            `Maximum characters to return (default ${DEFAULT_SNAPSHOT_MAX_CHARS}).`,
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "Limit the outline to the subtree matching this CSS selector.",
          ),
        tabId: tabIdField,
      }),
    },

    browser_screenshot: {
      annotations: { readOnlyHint: true },
      description:
        "Capture a screenshot of the visible area of a browser tab as an image. Use for visual checks (layout, styling); use browser_snapshot for reading content.",
      handler: withErrors(async ({ tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        await requireBridge().waitForLoad(guest, { timeoutMs: 5_000 });
        let image = await guest.capturePage();
        if (!image || image.isEmpty()) {
          return errorResult(
            "Screenshot came back empty. The browser panel may be hidden or the window minimized.",
          );
        }
        const { width, height } = image.getSize();
        if (width > SCREENSHOT_MAX_WIDTH) {
          image = image.resize({ width: SCREENSHOT_MAX_WIDTH });
        }
        const size = image.getSize();
        return {
          content: [
            {
              text: `tab ${resolvedTabId} · ${guest.getURL()} · captured ${width}x${height}${
                size.width !== width
                  ? `, scaled to ${size.width}x${size.height}`
                  : ""
              }`,
              type: "text",
            },
            {
              data: image.toJPEG(SCREENSHOT_JPEG_QUALITY).toString("base64"),
              mimeType: "image/jpeg",
              type: "image",
            },
          ],
        };
      }),
      inputSchema: z.object({ tabId: tabIdField }),
    },

    browser_click: {
      description:
        "Click an element identified by a snapshot ref or CSS selector. Dispatches real mouse events at the element's centre (falls back to element.click() if it is covered). Set doubleClick or button=right as needed.",
      handler: withErrors(
        async ({ button, doubleClick, ref, selector, tabId }) => {
          const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
          const locator = { ref, selector };
          const located = await locateForPointer(guest, locator);
          let method = "pointer";
          if (located.inViewport && !located.covered) {
            await clickAt(guest, located.x, located.y, {
              button: button ?? "left",
              clickCount: doubleClick ? 2 : 1,
            });
          } else {
            const fallback = await guest.executeJavaScript(
              buildProgrammaticClickScript(locator),
              true,
            );
            if (fallback?.error) {
              return errorResult(fallback.error);
            }
            method = located.covered
              ? `element.click() (pointer target covered by ${located.coveredBy?.tag ?? "another element"})`
              : "element.click() (element off-screen)";
          }
          // Clicks often trigger navigation; give it a moment to start.
          await sleep(100);
          const failure = await requireBridge().waitForLoad(guest, {
            timeoutMs: 5_000,
          });
          return textResult({
            clicked: located.element,
            method,
            ...guestSummary(guest, resolvedTabId),
            ...(describeLoadFailure(failure)
              ? { warning: describeLoadFailure(failure) }
              : {}),
          });
        },
      ),
      inputSchema: z.object({
        ...locatorFields,
        button: z.enum(["left", "right", "middle"]).optional(),
        doubleClick: z.boolean().optional(),
        tabId: tabIdField,
      }),
    },

    browser_type: {
      description:
        "Type text into an input, textarea or contenteditable element using real keyboard events. Set clear=true to replace the existing value, submit=true to press Enter afterwards.",
      handler: withErrors(
        async ({ clear, ref, selector, submit, tabId, text }) => {
          const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
          const focused = await guest.executeJavaScript(
            buildFocusForTypingScript(
              { ref, selector },
              { clear: Boolean(clear) },
            ),
            true,
          );
          if (!focused || focused.error) {
            return errorResult(focused?.error ?? "Could not focus element.");
          }
          if (!focused.focused) {
            // Some frameworks refuse programmatic focus; a real click gets it.
            const located = await locateForPointer(guest, { ref, selector });
            if (located.inViewport && !located.covered) {
              await clickAt(guest, located.x, located.y);
            }
            if (clear) {
              await sendKey(
                guest,
                process.platform === "darwin" ? "Meta+a" : "Control+a",
              );
            }
          }
          if (clear) {
            await sendKey(guest, "Backspace");
          }
          await typeText(guest, text);
          if (submit) {
            await sendKey(guest, "Enter");
            await sleep(100);
          }
          const failure = submit
            ? await requireBridge().waitForLoad(guest, { timeoutMs: 5_000 })
            : null;
          return textResult({
            typed: text.length,
            into: focused.element,
            ...guestSummary(guest, resolvedTabId),
            ...(describeLoadFailure(failure)
              ? { warning: describeLoadFailure(failure) }
              : {}),
          });
        },
      ),
      inputSchema: z.object({
        ...locatorFields,
        clear: z
          .boolean()
          .optional()
          .describe("Replace the current value instead of appending."),
        submit: z.boolean().optional().describe("Press Enter after typing."),
        tabId: tabIdField,
        text: z.string().describe("Text to type. Newlines are sent as Enter."),
      }),
    },

    browser_press_key: {
      description:
        'Press a key or key combination in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+A", "Shift+Tab". Sent to whatever element currently has focus.',
      handler: withErrors(async ({ key, tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        await sendKey(guest, key);
        await sleep(100);
        const failure = await requireBridge().waitForLoad(guest, {
          timeoutMs: 5_000,
        });
        return textResult({
          pressed: key,
          ...guestSummary(guest, resolvedTabId),
          ...(describeLoadFailure(failure)
            ? { warning: describeLoadFailure(failure) }
            : {}),
        });
      }),
      inputSchema: z.object({
        key: z.string().min(1),
        tabId: tabIdField,
      }),
    },

    browser_select_option: {
      description:
        "Choose option(s) in a <select> element by value or visible label.",
      handler: withErrors(async ({ ref, selector, tabId, values }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        const result = await guest.executeJavaScript(
          buildSelectOptionScript({ ref, selector }, values),
          true,
        );
        if (!result || result.error) {
          return errorResult(result?.error ?? "Select failed.");
        }
        return textResult({ ...result, tabId: resolvedTabId });
      }),
      inputSchema: z.object({
        ...locatorFields,
        tabId: tabIdField,
        values: z
          .array(z.string())
          .min(1)
          .describe("Option values or labels to select."),
      }),
    },

    browser_scroll: {
      description:
        "Scroll the page (or a scrollable element) by a pixel delta, and/or scroll an element into view. Positive deltaY scrolls down.",
      handler: withErrors(async ({ deltaX, deltaY, ref, selector, tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        const result = await guest.executeJavaScript(
          buildScrollScript({ deltaX, deltaY, ref, selector }),
          true,
        );
        if (!result || result.error) {
          return errorResult(result?.error ?? "Scroll failed.");
        }
        return textResult({ ...result, tabId: resolvedTabId });
      }),
      inputSchema: z.object({
        ...locatorFields,
        deltaX: z.number().optional(),
        deltaY: z
          .number()
          .optional()
          .describe("Pixels to scroll vertically (default 0)."),
        tabId: tabIdField,
      }),
    },

    browser_wait_for: {
      annotations: { readOnlyHint: true },
      description:
        "Wait until a CSS selector exists, the page text contains a string, and/or the URL contains a substring. Use after actions that trigger async UI updates.",
      handler: withErrors(
        async ({ selector, tabId, text, timeoutMs, urlIncludes }) => {
          if (!selector && !text && !urlIncludes) {
            return errorResult(
              "Provide at least one of selector, text or urlIncludes.",
            );
          }
          const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
          const limit = Math.min(
            Math.max(Number(timeoutMs) || WAIT_FOR_DEFAULT_TIMEOUT_MS, 100),
            WAIT_FOR_MAX_TIMEOUT_MS,
          );
          const deadline = Date.now() + limit;
          const script = buildWaitForScript({ selector, text, urlIncludes });
          let last = null;
          while (Date.now() < deadline) {
            if (guest.isDestroyed()) {
              return errorResult("Browser tab was closed.");
            }
            try {
              last = await guest.executeJavaScript(script, true);
            } catch {
              last = { ready: false, reason: "navigating" };
            }
            if (last?.error) {
              return errorResult(last.error);
            }
            if (last?.ready) {
              return textResult({
                ...last,
                tabId: resolvedTabId,
                waited: true,
              });
            }
            await sleep(150);
          }
          return errorResult(
            `Timed out after ${limit}ms waiting for ${
              last?.reason === "url"
                ? `URL to include ${JSON.stringify(urlIncludes)}`
                : last?.reason === "selector"
                  ? `selector ${JSON.stringify(selector)}`
                  : last?.reason === "text"
                    ? `text ${JSON.stringify(text)}`
                    : "the page"
            }. Current URL: ${guest.getURL()}`,
          );
        },
      ),
      inputSchema: z.object({
        selector: z.string().optional(),
        tabId: tabIdField,
        text: z.string().optional(),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe(
            `Default ${WAIT_FOR_DEFAULT_TIMEOUT_MS}, max ${WAIT_FOR_MAX_TIMEOUT_MS}.`,
          ),
        urlIncludes: z.string().optional(),
      }),
    },

    browser_evaluate: {
      description:
        "Run a JavaScript expression in the page and return its JSON-serialised result. Promises are awaited. Use for reading state (e.g. document.title, localStorage, fetch results) or small DOM manipulations.",
      handler: withErrors(async ({ expression, tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        const result = await guest.executeJavaScript(
          buildEvaluateScript(expression),
          true,
        );
        if (!result?.ok) {
          return errorResult(
            `${result?.error ?? "Evaluation failed."}${result?.stack ? `\n${result.stack}` : ""}`,
          );
        }
        return textResult({ result: result.result, tabId: resolvedTabId });
      }),
      inputSchema: z.object({
        expression: z
          .string()
          .min(1)
          .describe("JavaScript expression or IIFE."),
        tabId: tabIdField,
      }),
    },

    browser_console_logs: {
      annotations: { readOnlyHint: true },
      description:
        "Return console output (log/warn/error, including uncaught exceptions) captured from a browser tab since its last navigation. Set clear=true to reset the buffer after reading.",
      handler: withErrors(async ({ clear, level, tabId }) => {
        const { guest, tabId: resolvedTabId } = await acquireGuest(tabId);
        const minimum =
          level === "error"
            ? 3
            : level === "warning"
              ? 2
              : level === "info"
                ? 1
                : 0;
        const order = { debug: 0, error: 3, info: 1, warning: 2 };
        const entries = requireBridge()
          .getConsoleEntries(guest, { clear: Boolean(clear) })
          .filter((entry) => (order[entry.level] ?? 1) >= minimum);
        if (entries.length === 0) {
          return textResult(
            `No console output captured for tab ${resolvedTabId}${level ? ` at level ${level} or above` : ""}.`,
          );
        }
        const lines = entries.map((entry) => {
          const time = new Date(entry.timestamp).toISOString().slice(11, 23);
          const source = entry.sourceId
            ? ` (${entry.sourceId}${entry.lineNumber ? `:${entry.lineNumber}` : ""})`
            : "";
          return `[${time}] ${entry.level.toUpperCase()} ${entry.message}${source}`;
        });
        return textResult(lines.join("\n"));
      }),
      inputSchema: z.object({
        clear: z.boolean().optional(),
        level: z
          .enum(["debug", "info", "warning", "error"])
          .optional()
          .describe("Minimum level to include."),
        tabId: tabIdField,
      }),
    },
  };
};

/**
 * In-process MCP server config for the Claude Agent SDK `mcpServers` option.
 * Returns null when there is no project context or no live bridge (e.g. unit
 * tests, or a chat started without a project).
 */
export const createBrowserMcpServer = ({ projectId }) => {
  const bridge = getBrowserBridge();
  if (!bridge || typeof projectId !== "string" || projectId.length === 0) {
    return null;
  }
  return createCustomMcpServer({
    name: BROWSER_MCP_SERVER_NAME,
    tools: createBrowserToolDefinitions({ bridge, projectId }),
    version: "1.0.0",
  });
};
