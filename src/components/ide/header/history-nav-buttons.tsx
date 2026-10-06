import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useShortcutTitle } from "../shortcuts/shortcut-keys";
import { useShortcut } from "../shortcuts/shortcuts";
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
 * Back/Forward from the user's keyboard shortcuts (Settings > Keyboard
 * shortcuts), plus the fixed ways every browser offers: a keyboard's own
 * Back/Forward keys and a mouse's side buttons.
 */
export const HistoryNavButtons = () => {
  const t = useTranslations("common");
  const canGoBack = useNavigationHistoryStore((s) =>
    canGoBackInNavHistory(s.history),
  );
  const canGoForward = useNavigationHistoryStore((s) =>
    canGoForwardInNavHistory(s.history),
  );

  useEffect(() => startNavigationHistoryTracking(), []);

  useShortcut("navigateBack", () => navigateHistory(-1));
  useShortcut("navigateForward", () => navigateHistory(1));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const direction =
        event.key === "BrowserBack"
          ? -1
          : event.key === "BrowserForward"
            ? 1
            : null;
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
  }, []);

  const backTitle = useShortcutTitle("navigateBack", t("back"));
  const forwardTitle = useShortcutTitle("navigateForward", t("forward"));

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
