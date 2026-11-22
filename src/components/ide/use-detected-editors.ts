import { useEffect, useMemo, useState } from "react";
import { getDesktopApi } from "@/lib/electron";
import type { DetectedEditor } from "@/types/ide";

let detectedEditorsPromise: Promise<DetectedEditor[]> | null = null;

/** Installed editors don't change while the app runs; ask main once. */
const detectEditorsOnce = () => {
  const api = getDesktopApi();
  if (!api) {
    return null;
  }

  detectedEditorsPromise ??= api.detectEditors().catch(() => {
    detectedEditorsPromise = null;
    return [];
  });
  return detectedEditorsPromise;
};

/**
 * The "Open In" targets for a project: the OS file manager first, then every
 * editor main detected.
 */
export const useDetectedEditors = (isMacOs: boolean) => {
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([]);

  useEffect(() => {
    let cancelled = false;
    void detectEditorsOnce()?.then((editors) => {
      if (!cancelled) {
        setDetectedEditors(editors);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo<DetectedEditor[]>(() => {
    const fileExplorer = detectedEditors.find(
      (editor) => editor.id === "file-explorer",
    );
    const otherEditors = detectedEditors.filter(
      (editor) => editor.id !== "file-explorer",
    );

    return [
      fileExplorer ?? {
        executable: "",
        id: "file-explorer",
        isFileExplorer: true,
        isTerminal: false,
        name: isMacOs ? "Finder" : "File Explorer",
      },
      ...otherEditors,
    ];
  }, [detectedEditors, isMacOs]);
};
