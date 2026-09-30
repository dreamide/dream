// What each agent's tool calls look like on the wire, and what Dream reads
// from them. One table per question; a new provider or tool spelling is a
// new row, and no chip needs a test of tool names.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  describeAgent,
  describeCommand,
  describeList,
  describeMcp,
  describeRead,
  describeSearch,
  describeTaskOutput,
  describeWebFetch,
  describeWrite,
  getCommandOutputText,
  getToolKindForName,
  isChipToolKind,
  isDirectWebToolSearch,
  isToolKind,
  parseMcpToolName,
  toolNameKey,
} from "./tool-call.js";

// ── Kinds ─────────────────────────────────────────────────────────────

const KIND_BY_PROVIDER_TOOL_NAME = {
  // Claude Code names its tools itself; they reach Dream unrenamed.
  claude: {
    Agent: "agent",
    AskUserQuestion: "question",
    Bash: "command",
    Edit: "write",
    EnterPlanMode: "planMode",
    ExitPlanMode: "planMode",
    Glob: "search",
    Grep: "search",
    KillShell: null,
    MultiEdit: "write",
    NotebookEdit: "write",
    PowerShell: "command",
    Read: "read",
    Task: "agent",
    TaskCreate: "taskCreate",
    TaskOutput: "taskOutput",
    TaskUpdate: "taskUpdate",
    TodoWrite: "todo",
    ToolSearch: "toolSearch",
    WebFetch: "webFetch",
    WebSearch: "webFetch",
    Write: "write",
    mcp__github__create_issue: "mcp",
  },
  // Codex items, as the Codex adapter names them.
  codex: {
    "ask-user-question": "question",
    agent: "agent",
    "functions.update_plan": "todo",
    permissions: null,
    runCommand: "command",
    update_plan: "todo",
    writeFile: "write",
  },
  // OpenCode and ACP agents, after their adapters translate them.
  opencode: {
    agent: "agent",
    command: "command",
    listFiles: "list",
    readFile: "read",
    runCommand: "command",
    searchInFiles: "search",
    webFetch: "webFetch",
    writeFile: "write",
  },
  // Spellings seen from other versions and CLIs.
  aliases: {
    apply_patch: "write",
    collabAgentToolCall: "agent",
    exec_command: "command",
    file_change: "write",
    "list-files": "list",
    "run command": "command",
    shell_command: "command",
    spawn_agent: "agent",
    task_result: "taskOutput",
    "web-search": "webFetch",
  },
};

for (const [provider, table] of Object.entries(KIND_BY_PROVIDER_TOOL_NAME)) {
  test(`${provider} tool names resolve to their kinds`, () => {
    const actual = Object.fromEntries(
      Object.keys(table).map((name) => [name, getToolKindForName(name)]),
    );
    assert.deepEqual(actual, table);
  });
}

test("tool names reduce to one key however they are spelled", () => {
  for (const spelling of [
    "runCommand",
    "run_command",
    "run-command",
    "Run Command",
  ]) {
    assert.equal(toolNameKey(spelling), "runcommand", spelling);
  }
  assert.equal(toolNameKey("functions.update_plan"), "updateplan");
  assert.equal(toolNameKey(undefined), "");
});

test("mcp tool names split into server and command", () => {
  assert.deepEqual(parseMcpToolName("mcp__a__b__c"), {
    command: "b__c",
    server: "a",
  });
  assert.equal(parseMcpToolName("mcp__incomplete"), null);
  assert.deepEqual(describeMcp({ toolName: "mcp__db__query" }), {
    command: "query",
    server: "db",
  });
  assert.deepEqual(describeMcp({ toolName: "Bash" }), {
    command: null,
    server: null,
  });
});

test("only the chip kinds render as chips", () => {
  assert.equal(isToolKind("write"), true);
  assert.equal(isToolKind("teleport"), false);
  assert.equal(isChipToolKind("write"), true);
  assert.equal(isChipToolKind("question"), false);
  assert.equal(isChipToolKind(null), false);
});

// ── Reading calls ─────────────────────────────────────────────────────

/**
 * Each row: a provider's call as it arrives, and the fields Dream reads.
 * Only the fields named in `expect` are compared.
 */
const cases = [
  // Read
  {
    describe: describeRead,
    expect: { content: "one\ntwo", filename: "a.ts", path: "/p/src/a.ts" },
    name: "Claude Read: file_path in, text out",
    part: { input: { file_path: "/p/src/a.ts" }, output: "one\ntwo" },
  },
  {
    describe: describeRead,
    expect: { content: "", filename: "empty.md", path: "empty.md" },
    name: "OpenCode readFile: an empty file is content, not missing",
    part: {
      input: { filePath: "empty.md", path: "empty.md" },
      output: { content: "", filePath: "empty.md", status: "completed" },
    },
  },
  {
    describe: describeRead,
    expect: { endLine: 12, path: "lib/x.py", startLine: 10 },
    name: "line ranges from output, else input",
    part: {
      input: { end_line: 99, path: "lib/x.py", start_line: 10 },
      output: { content: "…", endLine: 12 },
    },
  },
  {
    describe: describeRead,
    expect: { content: null, filename: null, path: null },
    name: "a read still streaming its input",
    part: { input: undefined, output: undefined },
  },

  // Command
  {
    describe: describeCommand,
    expect: { command: "ls -la", outputText: "a\nb", status: null },
    name: "Claude Bash: command in, text out",
    part: { input: { command: "ls -la" }, output: "a\nb" },
  },
  {
    describe: describeCommand,
    expect: { command: "npm test", outputText: "ok", status: "completed" },
    name: "Codex runCommand: output record",
    part: {
      input: { command: "npm test", cwd: "/p", reason: null },
      output: { exitCode: 0, output: "ok", status: "completed" },
    },
  },
  {
    describe: describeCommand,
    expect: { outputText: "out\nerr" },
    name: "stdout and stderr are joined",
    part: { input: {}, output: { stderr: "err", stdout: "out" } },
  },
  {
    describe: describeCommand,
    expect: { command: null, commandType: "reboot", outputText: null },
    name: "a command with no text is labelled by its type",
    part: { input: { type: "reboot" }, output: { output: "" } },
  },

  // Write
  {
    describe: describeWrite,
    expect: {
      content: "export {};\n",
      edit: null,
      filename: "b.ts",
      path: "/p/b.ts",
    },
    name: "Claude Write: whole file",
    part: { input: { content: "export {};\n", file_path: "/p/b.ts" } },
  },
  {
    describe: describeWrite,
    expect: { edit: { next: "new", previous: "old" }, path: "c.ts" },
    name: "Claude Edit: replaced text",
    part: {
      input: { file_path: "c.ts", new_string: "new", old_string: "old" },
    },
  },
  {
    describe: describeWrite,
    expect: { edit: { next: "B\nD", previous: "A\nC" } },
    name: "Claude MultiEdit: edits joined",
    part: {
      input: {
        edits: [
          { new_string: "B", old_string: "A" },
          { new_string: "D", old_string: "C" },
        ],
        file_path: "d.ts",
      },
    },
  },
  {
    describe: describeWrite,
    expect: {
      changeStatus: "add",
      diff: "@@ -0,0 +1 @@\n+hi",
      filename: "new.txt",
      path: "docs/new.txt",
    },
    name: "Codex writeFile: a changes list",
    part: {
      input: {
        changes: [
          { diff: "@@ -0,0 +1 @@\n+hi", kind: "add", path: "docs/new.txt" },
        ],
        reason: null,
      },
    },
  },
  {
    describe: describeWrite,
    expect: {
      content: "after",
      mode: "overwrite",
      path: "e.txt",
      previousContent: "before",
    },
    name: "previous content from the output",
    part: {
      input: { content: "after", mode: "overwrite", path: "e.txt" },
      output: { previousContent: "before" },
    },
  },
  {
    describe: describeWrite,
    expect: {
      diff: null,
      outputMessage: "The file /repo/src/index.ts has been updated",
      path: "/repo/src/index.ts",
    },
    name: "a path named only in the reply; a blank diff is no diff",
    part: {
      input: {},
      output: "The file /repo/src/index.ts has been updated",
    },
  },
  {
    describe: describeWrite,
    expect: { path: "notes.md" },
    name: "a quoted path in the reply",
    part: { input: {}, output: "file 'notes.md' was created." },
  },
  {
    describe: describeWrite,
    expect: { outputMessage: "C:/dev/project/file.ts", path: null },
    name: "reply messages are unquoted with forward slashes",
    part: { input: {}, output: "'C:\\dev\\project\\file.ts'" },
  },
  {
    describe: describeWrite,
    expect: { outputMessage: "saved file" },
    name: "a reply record's message",
    part: { input: {}, output: { message: "  saved file  " } },
  },
  {
    describe: describeWrite,
    expect: { outputMessage: null, path: null },
    name: "no reply text",
    part: { input: {}, output: { status: "ok" } },
  },

  // Search
  {
    describe: describeSearch,
    expect: {
      count: 2,
      hasOutput: true,
      query: "TODO",
      textResults: ["src/a.ts", "src/b.ts"],
    },
    name: "Claude Grep: file list as text",
    part: { input: { pattern: "TODO" }, output: "src/a.ts\nsrc/b.ts\n" },
  },
  {
    describe: describeSearch,
    expect: { count: 0, hasOutput: false, textResults: [] },
    name: "Claude Glob: nothing found",
    part: { input: { pattern: "*.rs" }, output: "No files found" },
  },
  {
    describe: describeSearch,
    expect: { count: 7, hasOutput: true, query: "needle" },
    name: "structured matches with a total",
    part: {
      input: { pattern: "ignored", query: "needle" },
      output: {
        count: 7,
        matches: [{ file: "a.ts", line: 3, text: "needle()" }],
      },
    },
  },
  {
    describe: describeSearch,
    expect: { toolReferences: ["web_fetch", "database"] },
    name: "Claude ToolSearch: the tools it found",
    part: {
      input: { query: "select:WebFetch" },
      output: {
        matches: [{ tool_name: "web_fetch" }, { toolName: "database" }],
      },
    },
  },

  // List
  {
    describe: describeList,
    expect: { count: 2, directory: ".", files: ["a.ts", "b/c.ts"] },
    name: "OpenCode listFiles",
    part: {
      input: { directory: ".", path: "." },
      output: { count: 2, files: ["a.ts", { path: "b/c.ts" }], output: "…" },
    },
  },
  {
    describe: describeList,
    expect: { count: 0, files: null, pattern: "*.md" },
    name: "a listing with no file list",
    part: { input: { pattern: "*.md" }, output: "raw text" },
  },

  // Web
  {
    describe: describeWebFetch,
    expect: {
      isWebSearch: false,
      prompt: "Summarize",
      text: "# Title",
      url: "https://example.com/docs",
    },
    name: "Claude WebFetch",
    part: {
      input: { prompt: "Summarize", url: "https://example.com/docs" },
      output: { markdown: "# Title" },
      toolName: "WebFetch",
    },
  },
  {
    describe: describeWebFetch,
    expect: { isWebSearch: true, query: "vitest config", url: null },
    name: "Claude WebSearch",
    part: {
      input: { query: "vitest config" },
      output: "results…",
      toolName: "WebSearch",
    },
  },

  // Agents and background tasks
  {
    describe: describeAgent,
    expect: {
      agentType: "Explore",
      description: "Find callers",
      outputText: "Task complete.",
    },
    name: "Claude Task: usage footer removed",
    part: {
      input: { description: "Find callers", subagent_type: "Explore" },
      output: 'Task complete.\n\n<usage>{"tokens": 100}</usage>',
    },
  },
  {
    describe: describeAgent,
    expect: { agentType: "worker", outputText: "Here are the findings." },
    name: "Codex agent: agentId line removed",
    part: {
      input: { nickname: "worker" },
      output: "agentId: abc-123\nHere are the findings.",
    },
  },
  {
    describe: describeAgent,
    expect: { description: null, outputText: null },
    name: "an agent whose reply is only usage",
    part: { input: {}, output: "<usage>only usage</usage>" },
  },
  {
    describe: describeTaskOutput,
    expect: { outputText: "<done/>", taskId: "bash_1" },
    name: "Claude TaskOutput",
    part: { input: { task_id: "bash_1" }, output: "<done/>" },
  },
  {
    describe: describeTaskOutput,
    expect: { outputText: null, taskId: "t-2" },
    name: "a task id from the output",
    part: { input: {}, output: { taskId: "t-2" } },
  },
];

for (const { describe, expect, name, part } of cases) {
  test(`reads ${name}`, () => {
    const described = describe(part);
    const picked = Object.fromEntries(
      Object.keys(expect).map((key) => [key, described[key]]),
    );
    assert.deepEqual(picked, expect);
  });
}

test("a search match keeps its location, text and raw record", () => {
  const raw = { line_number: 4, path: "x.ts", preview: "let x" };
  const [match] = describeSearch({ input: {}, output: [raw] }).matches;
  assert.deepEqual(match, {
    file: "x.ts",
    line: 4,
    raw,
    text: "let x",
    toolName: null,
  });
});

test("command output is read loosely enough to find a diff in it", () => {
  assert.equal(
    getCommandOutputText({ output: "diff --git a b" }),
    "diff --git a b",
  );
  assert.equal(getCommandOutputText({ output: { stdout: "" } }), "");
  assert.equal(getCommandOutputText({ output: { exitCode: 1 } }), null);
});

test("a tool search for only the direct web tools is redundant", () => {
  assert.equal(isDirectWebToolSearch({ input: { query: "web_search" } }), true);
  assert.equal(isDirectWebToolSearch({ input: "WebFetch" }), true);
  assert.equal(
    isDirectWebToolSearch({
      input: { query: "browsing" },
      output: { matches: [{ tool_name: "web_fetch" }, "WebSearch"] },
    }),
    true,
  );
  assert.equal(
    isDirectWebToolSearch({
      input: { query: "browsing" },
      output: { matches: [{ tool_name: "web_fetch" }, { name: "database" }] },
    }),
    false,
  );
  assert.equal(isDirectWebToolSearch({ input: { query: "databases" } }), false);
});
