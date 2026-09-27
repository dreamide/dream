import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  captureAppScreenshot,
  ensurePngExtension,
  formatAppScreenshotFileName,
  isAppScreenshotShortcut,
} from "./app-screenshot.js";

const keyDown = (overrides) => ({
  alt: false,
  control: false,
  isAutoRepeat: false,
  key: "S",
  meta: false,
  shift: true,
  type: "keyDown",
  ...overrides,
});

test("matches Ctrl+Shift+S and Cmd+Shift+S", () => {
  assert.equal(isAppScreenshotShortcut(keyDown({ control: true })), true);
  assert.equal(isAppScreenshotShortcut(keyDown({ meta: true })), true);
  assert.equal(
    isAppScreenshotShortcut(keyDown({ control: true, key: "s" })),
    true,
  );
});

test("ignores near-miss key combinations", () => {
  assert.equal(isAppScreenshotShortcut(keyDown({})), false);
  assert.equal(
    isAppScreenshotShortcut(keyDown({ control: true, shift: false })),
    false,
  );
  assert.equal(
    isAppScreenshotShortcut(keyDown({ alt: true, control: true })),
    false,
  );
  assert.equal(
    isAppScreenshotShortcut(keyDown({ control: true, isAutoRepeat: true })),
    false,
  );
  assert.equal(
    isAppScreenshotShortcut(keyDown({ control: true, type: "keyUp" })),
    false,
  );
  assert.equal(
    isAppScreenshotShortcut(keyDown({ control: true, key: "d" })),
    false,
  );
  assert.equal(isAppScreenshotShortcut(undefined), false);
});

test("formats a Windows-safe, sortable file name", () => {
  assert.equal(
    formatAppScreenshotFileName(new Date(2026, 8, 6, 9, 5, 7)),
    "Dream 2026-09-06 09.05.07.png",
  );
});

test("appends .png only when the chosen name has no extension", () => {
  assert.equal(ensurePngExtension("/shots/a"), "/shots/a.png");
  assert.equal(ensurePngExtension("/shots/a.png"), "/shots/a.png");
  assert.equal(ensurePngExtension("/shots/a.PNG"), "/shots/a.PNG");
});

const tempDirectories = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const makeTempDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dream-shot-"));
  tempDirectories.push(directory);
  return directory;
};

const fakeImage = (bytes = Buffer.from("png-bytes")) => ({
  isEmpty: () => bytes.length === 0,
  toPNG: () => bytes,
});

const fakeWebContents = (image) => ({
  capturePage: async () => image,
  isDestroyed: () => false,
});

test("copies to the clipboard, then saves where the user chose", async () => {
  const root = await makeTempDirectory();
  const image = fakeImage();
  const copied = [];
  const offeredNames = [];
  const chosenPath = path.join(root, "picked.png");

  const result = await captureAppScreenshot({
    chooseSavePath: async (defaultFileName) => {
      offeredNames.push(defaultFileName);
      return chosenPath;
    },
    copyPng: async (value) => copied.push(value),
    now: () => new Date(2026, 0, 2, 3, 4, 5),
    webContents: fakeWebContents(image),
  });

  assert.deepEqual(result, { filePath: chosenPath, status: "saved" });
  assert.deepEqual(offeredNames, ["Dream 2026-01-02 03.04.05.png"]);
  assert.deepEqual(copied, [image.toPNG()]);
  assert.equal(await readFile(chosenPath, "utf8"), "png-bytes");
});

test("adds .png to a name typed without an extension", async () => {
  const root = await makeTempDirectory();

  const result = await captureAppScreenshot({
    chooseSavePath: async () => path.join(root, "no-extension"),
    copyPng: async () => {},
    webContents: fakeWebContents(fakeImage()),
  });

  const expectedPath = path.join(root, "no-extension.png");
  assert.deepEqual(result, { filePath: expectedPath, status: "saved" });
  assert.equal(await readFile(expectedPath, "utf8"), "png-bytes");
});

test("cancelling the dialog keeps the clipboard copy and writes nothing", async () => {
  const root = await makeTempDirectory();
  const copied = [];

  const result = await captureAppScreenshot({
    chooseSavePath: async () => null,
    copyPng: async (value) => copied.push(value),
    webContents: fakeWebContents(fakeImage()),
  });

  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(copied.length, 1);
  assert.deepEqual(await readdir(root), []);
});

test("still copies when the chosen file cannot be written", async () => {
  const root = await makeTempDirectory();
  const copied = [];

  const result = await captureAppScreenshot({
    chooseSavePath: async () => path.join(root, "missing-dir", "shot.png"),
    copyPng: async (value) => copied.push(value),
    webContents: fakeWebContents(fakeImage()),
  });

  assert.equal(result.status, "copied");
  assert.equal(typeof result.error, "string");
  assert.equal(copied.length, 1);
});

test("fails without copying or asking on an empty capture", async () => {
  const copied = [];
  let asked = false;

  const result = await captureAppScreenshot({
    chooseSavePath: async () => {
      asked = true;
      return null;
    },
    copyPng: async (value) => copied.push(value),
    webContents: fakeWebContents(fakeImage(Buffer.alloc(0))),
  });

  assert.equal(result.status, "failed");
  assert.equal(copied.length, 0);
  assert.equal(asked, false);
});

test("fails when the clipboard write rejects", async () => {
  const result = await captureAppScreenshot({
    chooseSavePath: async () => null,
    copyPng: async () => {
      throw new Error("clipboard busy");
    },
    webContents: fakeWebContents(fakeImage()),
  });

  assert.deepEqual(result, { error: "clipboard busy", status: "failed" });
});

test("fails when the window is gone", async () => {
  const result = await captureAppScreenshot({
    chooseSavePath: async () => null,
    copyPng: async () => {},
    webContents: { isDestroyed: () => true },
  });

  assert.equal(result.status, "failed");
});
