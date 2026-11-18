import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { createOpenCodeAuth } from "./opencode-auth.js";

const HOME = path.join("/home", "me");

const setup = ({ env = {}, file } = {}) => {
  const read = [];
  const auth = createOpenCodeAuth({
    env,
    homedir: () => HOME,
    readFile: async (filePath) => {
      read.push(filePath);
      if (file === undefined) throw new Error("ENOENT");
      return file;
    },
  });
  return { auth, read };
};

test("the Go key is read from ~/.local/share/opencode, or under $XDG_DATA_HOME", async () => {
  const home = setup({
    file: JSON.stringify({ "opencode-go": { key: " k " } }),
  });
  assert.equal(await home.auth.readGoApiKey(), "k");
  assert.deepEqual(home.read, [
    path.join(HOME, ".local", "share", "opencode", "auth.json"),
  ]);

  const xdg = setup({ env: { XDG_DATA_HOME: " /data " }, file: "{}" });
  await xdg.auth.readGoApiKey();
  assert.deepEqual(xdg.read, [path.join("/data", "opencode", "auth.json")]);
});

test("a missing or unparseable file, or no Go key, is no key", async () => {
  for (const file of [
    undefined,
    "{bad",
    "null",
    "{}",
    JSON.stringify({ "opencode-go": { key: "  " } }),
    JSON.stringify({ "opencode-go": { key: 5 } }),
    JSON.stringify({ openai: { key: "k" } }),
  ]) {
    assert.equal(await setup({ file }).auth.readGoApiKey(), null, String(file));
  }
});
