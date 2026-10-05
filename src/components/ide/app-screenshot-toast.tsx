import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import type { AppScreenshotResult } from "@/types/ide";

const SUCCESS_DURATION_MS = 4000;
const PROBLEM_DURATION_MS = 8000;

// While set on <html>, globals.css hides the Sonner toaster so no toast
// (this feature's or any other) ends up in the captured image.
const CAPTURING_ATTRIBUTE = "data-capturing-screenshot";

// Two frames: the first lets the browser paint without the toasts, the second
// guarantees that frame has been presented before the main process captures.
const waitForPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const getFileName = (filePath: string) =>
  filePath.split(/[\\/]/).pop() ?? filePath;

/**
 * Handles Ctrl/Cmd+Shift+S (detected in the main process) and reports the
 * result as a Sonner toast. Renders nothing itself; <Toaster /> is mounted
 * in IdeShell.
 */
export const AppScreenshotToast = () => {
  const t = useTranslations("screenshot");
  const capturingRef = useRef(false);
  const lastToastIdRef = useRef<string | number | null>(null);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    const showResult = (result: AppScreenshotResult) => {
      if (lastToastIdRef.current !== null) {
        toast.dismiss(lastToastIdRef.current);
      }

      switch (result.status) {
        case "saved": {
          const id = crypto.randomUUID();
          lastToastIdRef.current = toast.success(t("saved"), {
            // A React element is rendered as-is, so the toast doesn't dismiss
            // itself on click the way a { label, onClick } action does.
            action: (
              <Button
                onClick={() => {
                  toast.dismiss(id);
                  void desktopApi.showScreenshotInFolder(result.filePath);
                }}
                size="sm"
              >
                {t("showInFolder")}
              </Button>
            ),
            description: getFileName(result.filePath),
            duration: SUCCESS_DURATION_MS,
            id,
          });
          return;
        }
        case "cancelled":
          lastToastIdRef.current = toast.success(t("copied"), {
            duration: SUCCESS_DURATION_MS,
          });
          return;
        case "copied":
          lastToastIdRef.current = toast.warning(t("copiedNotSaved"), {
            description: result.error,
            duration: PROBLEM_DURATION_MS,
          });
          return;
        case "failed":
          lastToastIdRef.current = toast.error(t("failed"), {
            description: result.error,
            duration: PROBLEM_DURATION_MS,
          });
          return;
      }
    };

    const removeListener = desktopApi.onAppScreenshotRequested(async () => {
      if (capturingRef.current) {
        return;
      }
      capturingRef.current = true;

      const root = document.documentElement;
      let result: AppScreenshotResult;
      try {
        root.setAttribute(CAPTURING_ATTRIBUTE, "");
        await waitForPaint();
        // Resolves after the Save dialog closes; the image was taken before
        // the dialog opened.
        result = await desktopApi.captureAppScreenshot();
      } catch (error) {
        result = {
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        };
      } finally {
        root.removeAttribute(CAPTURING_ATTRIBUTE);
        capturingRef.current = false;
      }

      showResult(result);
    });

    return () => {
      removeListener();
      document.documentElement.removeAttribute(CAPTURING_ATTRIBUTE);
    };
  }, [t]);

  return null;
};
