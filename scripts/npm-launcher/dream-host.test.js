import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveName,
  expectedChecksum,
  installRuntime,
  LauncherError,
  runtimeCommand,
  runtimeTarget,
} from "./dream-host.js";

let root;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dream-launcher-"));
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const ARCHIVE = Buffer.from("not really a tarball");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A release server: the archive and its SHA256SUMS. */
const releaseFetch = ({ sums } = {}) => {
  const requested = [];
  const name = archiveName("1.2.3", { arch: "x64", os: "linux" });
  const files = {
    [`https://example.test/v1.2.3/${name}`]: ARCHIVE,
    "https://example.test/v1.2.3/SHA256SUMS": Buffer.from(
      sums ?? `${sha(ARCHIVE)}  ${name}\n`,
    ),
  };
  return {
    fetchImpl: async (url) => {
      requested.push(url);
      const body = files[url];
      return body
        ? new Response(body)
        : new Response("missing", { status: 404 });
    },
    requested,
  };
};

/** `tar` unpacks a runtime layout; the runtime's `version` succeeds. */
const fakeRun = (calls) => (program, args) => {
  calls.push([path.basename(program), args.at(-1)]);
  if (args[0] === "-xzf") {
    const into = args.at(-1);
    mkdirSync(path.join(into, "node"), { recursive: true });
    mkdirSync(path.join(into, "lib"), { recursive: true });
    writeFileSync(path.join(into, "lib", "dream-host.js"), "");
  }
  return { status: 0, stderr: "", stdout: "" };
};

const install = (options) =>
  installRuntime({
    arch: "x64",
    baseUrl: "https://example.test/v1.2.3",
    log: () => {},
    platform: "linux",
    root,
    version: "1.2.3",
    ...options,
  });

describe("the npm launcher", () => {
  it("names this machine as the release's archives do", () => {
    expect(runtimeTarget("win32", "x64")).toEqual({
      arch: "x64",
      os: "windows",
    });
    expect(runtimeTarget("darwin", "x64")).toBeNull();
    expect(archiveName("1.2.3", { arch: "arm64", os: "darwin" })).toBe(
      "dream-host-1.2.3-darwin-arm64.tar.gz",
    );
    expect(runtimeCommand("/r", "win32").program).toMatch(/node\.exe$/);
  });

  it("reads a checksum in either sha256sum format", () => {
    const sums = "aa  one.tar.gz\nBB *two.tar.gz\n";
    expect(expectedChecksum(sums, "one.tar.gz")).toBe("aa");
    expect(expectedChecksum(sums, "two.tar.gz")).toBe("bb");
    expect(expectedChecksum(sums, "three.tar.gz")).toBeNull();
  });

  it("installs a checked runtime once, then reuses it", async () => {
    const calls = [];
    const release = releaseFetch();
    const directory = await install({
      fetchImpl: release.fetchImpl,
      run: fakeRun(calls),
    });
    expect(directory).toBe(path.join(root, "1.2.3"));
    expect(existsSync(path.join(directory, ".install-complete"))).toBe(true);
    expect(calls.map(([program, last]) => [program, last])).toEqual([
      ["tar", expect.stringContaining("runtime")],
      ["node", "version"],
    ]);

    const again = releaseFetch();
    await install({ fetchImpl: again.fetchImpl, run: fakeRun([]) });
    expect(again.requested).toEqual([]);
  });

  it("installs nothing when the download does not match its checksum", async () => {
    const name = archiveName("1.2.3", { arch: "x64", os: "linux" });
    const release = releaseFetch({ sums: `${"0".repeat(64)}  ${name}\n` });
    await expect(
      install({ fetchImpl: release.fetchImpl, run: fakeRun([]) }),
    ).rejects.toThrow(/checksum/);
    expect(existsSync(path.join(root, "1.2.3"))).toBe(false);
    // The lock is released for the next attempt.
    expect(existsSync(path.join(root, ".lock-1.2.3"))).toBe(false);
  });

  it("says which platforms exist when this one has no runtime", async () => {
    await expect(install({ platform: "freebsd" })).rejects.toThrow(
      LauncherError,
    );
    await expect(install({ platform: "freebsd" })).rejects.toThrow(/linux-x64/);
  });

  it("refuses a runtime that does not run here", async () => {
    const release = releaseFetch();
    const run = (program, args) =>
      args[0] === "-xzf"
        ? fakeRun([])(program, args)
        : { status: 1, stderr: "Exec format error", stdout: "" };
    await expect(
      install({ fetchImpl: release.fetchImpl, run }),
    ).rejects.toThrow(/does not run on this machine: Exec format error/);
    expect(existsSync(path.join(root, "1.2.3"))).toBe(false);
  });
});
