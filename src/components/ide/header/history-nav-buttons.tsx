import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useIdeStore } from "../ide-store";
import {
  canGoBackInNavHistory,
  canGoForwardInNavHistory,
} from "../store/navigation-history";
import {
  navigateHistory,
  startNavigationHistoryTracking,
  useNavigationHistoryStore,
} from "../store/navigation-history-store";
import { WorkspaceNavButton } from "../workspace/nav-button";

// Mouse side buttons, as reported by MouseEvent.button.
const MOUSE_BUTTON_BACK = 3;
const MOUSE_BUTTON_FORWARD = 4;

/**
 * The terminal and the code editor bind these same keys themselves (word
 * movement, indent), so a shortcut typed there belongs to them.
 */
const isInsideOwnKeyHandler = (target: EventTarget | null) =>
  target instanceof Element && target.closest(".xterm, .cm-editor") !== null;

const getShortcutDirection = (
  event: KeyboardEvent,
  isMacOs: boolean,
): -1 | 1 | null => {
  if (event.key === "BrowserBack") return -1;
  if (event.key === "BrowserForward") return 1;
  if (event.shiftKey) return null;

  if (isMacOs) {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null;
    if (event.key === "[") return -1;
    if (event.key === "]") return 1;
    return null;
  }

  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
};

export const HistoryNavButtons = () => {
  const t = useTranslations("common");
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const canGoBack = useNavigationHistoryStore((s) =>
    canGoBackInNavHistory(s.history),
  );
  const canGoForward = useNavigationHistoryStore((s) =>
    canGoForwardInNavHistory(s.history),
  );

  useEffect(() => startNavigationHistoryTracking(), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isInsideOwnKeyHandler(event.target)) {
        return;
      }

      const direction = getShortcutDirection(event, isMacOs);
      if (direction === null) {
        return;
      }

      event.preventDefault();
      navigateHistory(direction);
    };

    const handleMouseUp = (event: MouseEvent) => {
      const direction =
        event.button === MOUSE_BUTTON_BACK
          ? -1
          : event.button === MOUSE_BUTTON_FORWARD
            ? 1
            : null;
      if (direction === null) {
        return;
      }

      event.preventDefault();
      navigateHistory(direction);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isMacOs]);

  const backTitle = `${t("back")} (${isMacOs ? "⌘[" : "Alt+←"})`;
  const forwardTitle = `${t("forward")} (${isMacOs ? "⌘]" : "Alt+→"})`;

  return (
    <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
      <WorkspaceNavButton
        aria-label={t("back")}
        disabled={!canGoBack}
        onClick={() => navigateHistory(-1)}
        title={backTitle}
        type="button"
      >
        <ArrowLeft className="size-4" />
      </WorkspaceNavButton>
      <WorkspaceNavButton
        aria-label={t("forward")}
        disabled={!canGoForward}
        onClick={() => navigateHistory(1)}
        title={forwardTitle}
        type="button"
      >
        <ArrowRight className="size-4" />
      </WorkspaceNavButton>
    </div>
  );
};
