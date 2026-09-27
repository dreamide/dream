import { writeFile } from "node:fs/promises";
import path from "node:path";

// Ctrl+Shift+S on Windows/Linux, Cmd+Shift+S on macOS. Either modifier is
// accepted on every platform, matching how the reload shortcut is handled.
export function isAppScreenshotShortcut(input) {
  if (input?.type !== "keyDown" || input.isAutoRepeat) {
    return false;
  }

  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  return (
    key === "s" &&
    Boolean(input.control || input.meta) &&
    Boolean(input.shift) &&
    !input.alt
  );
}

const pad = (value) => String(value).padStart(2, "0");

// Colons are not allowed in Windows file names, so the time uses dots.
export function formatAppScreenshotFileName(date) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Dream ${day} ${time}.png`;
}

// A name typed without an extension still ends up as a PNG.
export function ensurePngExtension(filePath) {
  return path.extname(filePath) ? filePath : `${filePath}.png`;
}

/**
 * Captures the window and copies it to the clipboard, then asks where to
 * save it. Dependencies are injected so this can be tested without Electron:
 * - copyPng(pngBuffer): async clipboard write (see main.js)
 * - chooseSavePath(defaultFileName): resolves to a path, or null if cancelled
 *
 * The clipboard copy happens first so cancelling the dialog, or a failed
 * save, still leaves the user with something to paste.
 *
 * Resolves to { status: "saved", filePath } | { status: "cancelled" }
 * | { status: "copied", error } | { status: "failed", error }. Never rejects.
 */
export async function captureAppScreenshot({
  chooseSavePath,
  copyPng,
  now = () => new Date(),
  webContents,
}) {
  let png;
  try {
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("The app window is not available.");
    }

    const image = await webContents.capturePage();
    if (!image || image.isEmpty()) {
      throw new Error("The window returned an empty image.");
    }

    png = image.toPNG();
    await copyPng(png);
  } catch (error) {
    return { error: getErrorMessage(error), status: "failed" };
  }

  try {
    const chosenPath = await chooseSavePath(formatAppScreenshotFileName(now()));
    if (!chosenPath) {
      return { status: "cancelled" };
    }

    const filePath = ensurePngExtension(chosenPath);
    await writeFile(filePath, png);
    return { filePath, status: "saved" };
  } catch (error) {
    return { error: getErrorMessage(error), status: "copied" };
  }
}

function getErrorMessage(error) {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}
