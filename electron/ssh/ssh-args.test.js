import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  buildDirectForwardArgs,
  buildEnsureArgs,
  buildEnsureCommand,
  buildMasterArgs,
  buildMasterForwardArgs,
  quoteShellWord,
} from "./ssh-args.js";

test("quotes words for a POSIX shell", () => {
  expect(quoteShellWord("plain")).toBe("'plain'");
  expect(quoteShellWord("it's")).toBe(`'it'\\''s'`);
});

test.skipIf(process.platform === "win32")(
  "the ensure command runs the host command through a login shell",
  () => {
    const output = execFileSync("sh", ["-c", buildEnsureCommand("echo ok")], {
      env: { ...process.env, SHELL: "/bin/sh" },
    }).toString();
    expect(output.trim()).toBe("ok ensure");
  },
);

test("the multiplexed master holds the connection open on stdin", () => {
  const args = buildMasterArgs({ controlPath: "/c/%C", target: "box" });
  expect(args).toEqual(
    expect.arrayContaining(["-M", "-S", "/c/%C", "ControlPersist=no"]),
  );
  expect(args.slice(-2)).toEqual(["box", "cat >/dev/null"]);
});

test("ensure goes through the master when there is one", () => {
  expect(
    buildEnsureArgs({ controlPath: "/c/%C", hostCommand: "dh", target: "box" }),
  ).toEqual(expect.arrayContaining(["-S", "/c/%C", "-T", "box"]));
  expect(
    buildEnsureArgs({ controlPath: null, hostCommand: "dh", target: "box" }),
  ).not.toContain("-S");
});

test("forwards bind loopback on both ends", () => {
  const ports = { localPort: 5000, remotePort: 6000 };
  expect(
    buildMasterForwardArgs({ controlPath: "/c/%C", target: "box", ...ports }),
  ).toEqual([
    "-S",
    "/c/%C",
    "-O",
    "forward",
    "-L",
    "127.0.0.1:5000:127.0.0.1:6000",
    "box",
  ]);

  const direct = buildDirectForwardArgs({ target: "box", ...ports });
  expect(direct).toEqual(
    expect.arrayContaining([
      "ExitOnForwardFailure=yes",
      "-L",
      "127.0.0.1:5000:127.0.0.1:6000",
    ]),
  );
  expect(direct.slice(-2)).toEqual(["box", "cat >/dev/null"]);
});
