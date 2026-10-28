import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { parseSshConfig, readSshConfigHosts } from "./ssh-config-hosts.js";

test("only Host names that name one host are aliases", () => {
  const parsed = parseSshConfig(
    [
      "# comment",
      "Host devbox  build-* !secret",
      "  HostName 10.0.0.2",
      'Host=gpu "quoted box"',
      "host *",
      "Include config.d/*",
      "Match host other",
    ].join("\n"),
  );
  assert.deepEqual(parsed.hosts, ["devbox", "gpu", "quoted box"]);
  assert.deepEqual(parsed.includes, ["config.d/*"]);
});

test("includes are followed once, relative to ~/.ssh, with globs", async () => {
  // Absolute on every platform: on Windows, path.resolve adds the drive.
  const home = path.resolve("/home/me");
  const files = {
    [path.join(home, ".ssh/config")]:
      "Host a\nInclude config.d/*.conf ~/other/config\nInclude config",
    [path.join(home, ".ssh/config.d/1.conf")]: "Host b\nHost a",
    [path.join(home, ".ssh/config.d/2.conf")]: "Host c",
    [path.join(home, "other/config")]: "Host d",
  };
  const hosts = await readSshConfigHosts({
    home,
    list: async (folder) =>
      folder === path.join(home, ".ssh/config.d")
        ? ["2.conf", "1.conf", "notes.txt"]
        : [],
    read: async (file) => {
      const text = files[file];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  });
  assert.deepEqual(hosts, ["a", "b", "c", "d"]);
});

test("no config means no aliases", async () => {
  const hosts = await readSshConfigHosts({
    home: "/nobody",
    read: async () => {
      throw new Error("ENOENT");
    },
  });
  assert.deepEqual(hosts, []);
});
