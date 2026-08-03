import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatToolName,
  getCommandWithoutShellPrefix,
  readShellToken,
  stripAnsiSequences,
  unquoteCommandArgument,
} from "@/components/ide/assistant-message/command-utils";

test("stripAnsiSequences removes color and control sequences", () => {
  assert.equal(stripAnsiSequences("\u001B[31mred\u001B[0m text"), "red text");
  assert.equal(stripAnsiSequences("\u001B];window title\u0007plain"), "plain");
  assert.equal(stripAnsiSequences("no escapes here"), "no escapes here");
});

test("unquoteCommandArgument removes matching quotes and unescapes double quotes", () => {
  assert.equal(unquoteCommandArgument('  "npm run test"  '), "npm run test");
  assert.equal(unquoteCommandArgument('"say \\"hi\\""'), 'say "hi"');
  assert.equal(
    unquoteCommandArgument("'echo \\\"kept\\\"'"),
    'echo \\"kept\\"',
  );
  assert.equal(unquoteCommandArgument("'mismatched\""), "'mismatched\"");
  assert.equal(unquoteCommandArgument("x"), "x");
});

test("readShellToken reads whitespace-delimited and quoted tokens", () => {
  assert.deepEqual(readShellToken("  bash -c 'ls'", 0), {
    endIndex: 6,
    token: "bash",
  });
  assert.deepEqual(readShellToken('"quoted token" rest', 0), {
    endIndex: 14,
    token: "quoted token",
  });
  assert.deepEqual(readShellToken("'unterminated", 0), {
    endIndex: 13,
    token: "unterminated",
  });
  assert.equal(readShellToken("cmd   ", 3), null);
});

test("getCommandWithoutShellPrefix unwraps posix shell -c invocations", () => {
  assert.equal(getCommandWithoutShellPrefix('bash -c "npm test"'), "npm test");
  assert.equal(getCommandWithoutShellPrefix("/bin/zsh -lc 'ls -la'"), "ls -la");
  assert.equal(getCommandWithoutShellPrefix("sh -c echo hi"), "echo hi");
});

test("getCommandWithoutShellPrefix unwraps powershell command invocations", () => {
  assert.equal(
    getCommandWithoutShellPrefix('pwsh -Command "Get-ChildItem"'),
    "Get-ChildItem",
  );
  assert.equal(
    getCommandWithoutShellPrefix('powershell.exe -NoProfile -Command "dir"'),
    "dir",
  );
  assert.equal(
    getCommandWithoutShellPrefix("C:\\tools\\pwsh.exe -c Get-Date"),
    "Get-Date",
  );
});

test("getCommandWithoutShellPrefix leaves non-shell and non-flag commands alone", () => {
  assert.equal(getCommandWithoutShellPrefix("git status"), "git status");
  assert.equal(
    getCommandWithoutShellPrefix("bash script.sh"),
    "bash script.sh",
  );
  assert.equal(getCommandWithoutShellPrefix("bash -x"), "bash -x");
  assert.equal(getCommandWithoutShellPrefix(""), "");
});

test("formatToolName converts identifiers into title-cased words", () => {
  assert.equal(formatToolName("run_command"), "Run Command");
  assert.equal(formatToolName("webFetch"), "Web Fetch");
  assert.equal(formatToolName("multi-edit"), "Multi Edit");
  assert.equal(formatToolName("  read  file  "), "Read File");
});
