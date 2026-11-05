/**
 * Calls back when the person comes back to this window from somewhere
 * else: another app (the window regains focus) or another tab (the page
 * becomes visible). Focus moving into one of this window's own
 * frames (the browser panel's webview) is not leaving, so clicking between
 * the page and the panel does not count.
 */

type ReturnTarget = {
  document: Pick<
    Document,
    "activeElement" | "visibilityState" | "addEventListener"
  > &
    Pick<Document, "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
};

/** Focus inside these elements stays in this window. */
const FRAME_TAGS = new Set(["IFRAME", "WEBVIEW"]);

export const watchWindowReturn = (
  onReturn: () => void,
  target: ReturnTarget = { document, window },
) => {
  let away = target.document.visibilityState === "hidden";
  const leave = () => {
    // Focus moving into a frame blurs the page with the frame already
    // active; leaving the window entirely leaves no frame active.
    const active = target.document.activeElement;
    if (active && FRAME_TAGS.has(active.tagName)) return;
    away = true;
  };
  const back = () => {
    if (!away) return;
    away = false;
    onReturn();
  };
  const onVisibility = () => {
    if (target.document.visibilityState === "hidden") away = true;
    else back();
  };
  target.window.addEventListener("blur", leave);
  target.window.addEventListener("focus", back);
  target.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    target.window.removeEventListener("blur", leave);
    target.window.removeEventListener("focus", back);
    target.document.removeEventListener("visibilitychange", onVisibility);
  };
};
