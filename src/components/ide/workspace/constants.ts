import { DEFAULT_PANEL_SIZES } from "@/lib/ide-defaults";
import type { BrowserTabState } from "@/types/ide";

export const CHAT_PANEL_MIN_WIDTH_PX = 450;
export const WORKSPACE_VIEWPORT_BACKGROUND =
  "color-mix(in oklab, var(--muted) 50%, var(--background))";
export const BROWSER_PANEL_DEFAULT_WIDTH_PX =
  DEFAULT_PANEL_SIZES.rightPanelWidth;
export const BROWSER_PANEL_MIN_WIDTH_PX = 320;
export const CHAT_PANEL_MIN_HEIGHT_PX = 180;
export const PANEL_RESIZE_HANDLE_SIZE_PX = 1;
export const PANEL_EDGE_PADDING_PX = 8;
export const WORKSPACE_SIDE_NAV_WIDTH_PX = 48;
export const EMPTY_TERMINAL_SESSION_IDS: string[] = [];
export const EMPTY_BROWSER_TABS: BrowserTabState[] = [];
export const CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX = 400;
export const CHAT_HISTORY_PANEL_MAX_WIDTH_PX = 500;
export const CHAT_HISTORY_PANEL_MIN_WIDTH_PX = 200;

/** Duration (ms) for panel slide animations. */
export const PANEL_TRANSITION_MS = 200;
export const PANEL_TRANSITION = `width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), min-width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), max-width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), padding ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
export const SLIDING_PANEL_TRANSITION = `width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), transform ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
export const CHAT_KEEP_ALIVE_LIMIT = 10;

export const clampChatHistoryPanelWidth = (width: number) =>
  Math.max(
    CHAT_HISTORY_PANEL_MIN_WIDTH_PX,
    Math.min(CHAT_HISTORY_PANEL_MAX_WIDTH_PX, width),
  );
