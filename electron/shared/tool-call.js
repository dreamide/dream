// @ts-check
// What a tool call is, whichever agent made it.
//
// Every agent names its tools differently (Claude's `Read`, Codex's
// `commandExecution` as Dream's `runCommand`, OpenCode's `bash`) and shapes
// their input and output differently (`file_path`, `filePath`, `path`,
// `file.path`, a `changes` list...). This module is the one place that knows
// those spellings. It is used on both sides of the stream:
//
//   the turn writer (main process) stamps each tool part it writes with
//   `toolMetadata.kind`, so a part says what it is from the moment it exists;
//
//   the transcript (renderer) reads a part through `describe*`, which turn
//   the raw input and output into the typed fields a chip renders. A part
//   saved before kinds were stamped is classified by name, with the same
//   table.
//
// Adding a tool spelling means adding it here, and nowhere else.

/**
 * @typedef {"agent" | "command" | "list" | "mcp" | "planMode" | "question"
 *   | "read" | "search" | "taskCreate" | "taskOutput" | "taskUpdate" | "todo"
 *   | "toolSearch" | "webFetch" | "write"} ToolKind
 */

/**
 * The kinds a tool chip renders; every other tool (and every tool of an
 * unknown kind) renders as a generic tool call.
 * @typedef {"agent" | "command" | "list" | "mcp" | "read" | "search"
 *   | "taskOutput" | "toolSearch" | "webFetch" | "write"} ChipToolKind
 */

/**
 * The fields a tool part carries that this module reads.
 * @typedef {object} ToolCallSource
 * @property {string} [toolName]
 * @property {unknown} [input]
 * @property {unknown} [output]
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {value is string} */
const isString = (value) => typeof value === "string";

// ── Names ─────────────────────────────────────────────────────────────

/**
 * A tool name reduced to what identifies it: the last `.`/`:`/`/` segment,
 * without separators, lowercased. `Bash`, `run_command`, `runCommand` and
 * `functions.update_plan` become `bash`, `runcommand`, `runcommand` and
 * `updateplan`.
 * @param {unknown} name
 */
export const toolNameKey = (name) =>
  (
    String(name ?? "")
      .split(/[.:/]+/)
      .pop() ?? ""
  )
    .replace(/[\s_-]+/g, "")
    .toLowerCase();

const MCP_TOOL_NAME_PATTERN = /^mcp__(.+?)__(.+)$/;

/**
 * `mcp__<server>__<command>`, as Claude and Dream name MCP tools.
 * @param {string} name
 * @returns {{ command: string, server: string } | null}
 */
export const parseMcpToolName = (name) => {
  const match = MCP_TOOL_NAME_PATTERN.exec(name);
  return match ? { command: match[2], server: match[1] } : null;
};

/**
 * Every known spelling of each kind, as `toolNameKey` reduces it.
 * @type {Record<Exclude<ToolKind, "mcp">, readonly string[]>}
 */
export const TOOL_NAMES_BY_KIND = {
  agent: [
    "agent",
    "collabagenttoolcall",
    "collaborationspawnagent",
    "spawnagent",
    "task",
  ],
  command: [
    "bash",
    "command",
    "execcommand",
    "powershell",
    "runcommand",
    "shellcommand",
  ],
  list: ["listfiles"],
  planMode: ["enterplanmode", "exitplanmode"],
  question: ["askuserquestion"],
  read: ["read", "readfile"],
  search: ["glob", "grep", "search", "searchinfiles"],
  taskCreate: ["createtask", "taskcreate"],
  taskOutput: ["taskoutput", "taskresult"],
  taskUpdate: ["taskupdate", "updatetask"],
  todo: [
    "todo",
    "todolist",
    "todos",
    "todowrite",
    "updateplan",
    "updatetodo",
    "updatetodos",
  ],
  toolSearch: ["toolsearch"],
  webFetch: ["fetch", "webfetch", "websearch"],
  write: [
    "applypatch",
    "edit",
    "filechange",
    "multiedit",
    "notebookedit",
    "patch",
    "write",
    "writefile",
  ],
};

/** @type {Map<string, ToolKind>} */
const KIND_BY_NAME_KEY = new Map(
  Object.entries(TOOL_NAMES_BY_KIND).flatMap(([kind, names]) =>
    names.map((name) => [name, /** @type {ToolKind} */ (kind)]),
  ),
);

/** @type {ReadonlySet<string>} */
const TOOL_KINDS = new Set([...Object.keys(TOOL_NAMES_BY_KIND), "mcp"]);

/** @type {ReadonlySet<string>} */
const CHIP_TOOL_KINDS = new Set([
  "agent",
  "command",
  "list",
  "mcp",
  "read",
  "search",
  "taskOutput",
  "toolSearch",
  "webFetch",
  "write",
]);

/** @param {unknown} value @returns {value is ToolKind} */
export const isToolKind = (value) => isString(value) && TOOL_KINDS.has(value);

/** @param {ToolKind | null} kind @returns {kind is ChipToolKind} */
export const isChipToolKind = (kind) =>
  kind !== null && CHIP_TOOL_KINDS.has(kind);

/**
 * What a tool is, from its name alone; null for a tool Dream has no special
 * rendering for.
 * @param {unknown} toolName
 * @returns {ToolKind | null}
 */
export const getToolKindForName = (toolName) => {
  if (isString(toolName) && parseMcpToolName(toolName)) {
    return "mcp";
  }
  return KIND_BY_NAME_KEY.get(toolNameKey(toolName)) ?? null;
};

// ── Probing ───────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {readonly string[]} path
 * @returns {unknown}
 */
const getNestedValue = (value, path) => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
};

/**
 * The first string found at any of `paths` (an empty path is the value
 * itself). Empty strings are skipped unless `allowEmpty`.
 * @param {unknown} value
 * @param {ReadonlyArray<readonly string[]>} paths
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string | null}
 */
export const getStringFromPaths = (value, paths, options) => {
  for (const path of paths) {
    const candidate = path.length === 0 ? value : getNestedValue(value, path);
    if (isString(candidate) && (options?.allowEmpty || candidate.length > 0)) {
      return candidate;
    }
  }
  return null;
};

/**
 * @param {unknown} value
 * @param {ReadonlyArray<readonly string[]>} paths
 * @returns {number | null}
 */
export const getNumberFromPaths = (value, paths) => {
  for (const path of paths) {
    const candidate = path.length === 0 ? value : getNestedValue(value, path);
    if (typeof candidate === "number") {
      return candidate;
    }
  }
  return null;
};

/** @param {string | null} filePath */
const getBasename = (filePath) => {
  const basename = filePath?.split(/[\\/]/).pop();
  return basename ? basename : null;
};

/** @param {unknown} value */
const stringOrNull = (value) => (isString(value) ? value : null);

// ── Read ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} ReadToolCall
 * @property {string | null} path
 * @property {string | null} filename
 * @property {string | null} content  What was read ("" is a real empty file).
 * @property {number | null} startLine
 * @property {number | null} endLine
 */

/** @param {ToolCallSource} part @returns {ReadToolCall} */
export const describeRead = ({ input, output }) => {
  const path =
    getStringFromPaths(input, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["file", "path"],
      ["file", "filePath"],
    ]) ??
    getStringFromPaths(output, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["file"],
      ["file", "path"],
      ["file", "filePath"],
    ]);
  const lineNumber = (/** @type {string[]} */ ...keys) =>
    getNumberFromPaths(
      output,
      keys.map((key) => [key]),
    ) ??
    getNumberFromPaths(
      input,
      keys.map((key) => [key]),
    );

  return {
    content:
      getStringFromPaths(
        output,
        [
          [],
          ["content"],
          ["text"],
          ["contents"],
          ["file", "content"],
          ["file", "text"],
        ],
        { allowEmpty: true },
      ) ??
      getStringFromPaths(input, [["content"], ["text"]], { allowEmpty: true }),
    endLine: lineNumber("endLine", "end_line"),
    filename:
      getBasename(path) ??
      getStringFromPaths(input, [["filename"], ["name"], ["file", "name"]]) ??
      getStringFromPaths(output, [["filename"], ["name"], ["file", "name"]]),
    path,
    startLine: lineNumber("startLine", "start_line"),
  };
};

// ── Command ───────────────────────────────────────────────────────────

/**
 * @typedef {object} CommandToolCall
 * @property {string | null} command
 * @property {string | null} commandType  A label for commands with no text.
 * @property {string | null} outputText   Combined output, ANSI codes kept.
 * @property {string | null} status       "running" while the process lives.
 */

/** @param {ToolCallSource} part @returns {CommandToolCall} */
export const describeCommand = ({ input, output }) => {
  const field = (/** @type {string} */ key) =>
    (isRecord(input) ? stringOrNull(input[key]) : null) ??
    (isRecord(output) ? stringOrNull(output[key]) : null);

  /** @type {string | null} */
  let outputText = null;
  if (isString(output)) {
    outputText = output;
  } else if (isRecord(output)) {
    const combined = [output.stdout, output.stderr]
      .filter(isString)
      .join(output.stdout && output.stderr ? "\n" : "");
    outputText =
      (isString(output.output) && output.output) ||
      combined ||
      (isString(output.result) ? output.result : null) ||
      null;
  }

  return {
    command: field("command"),
    commandType: field("type"),
    outputText,
    status: isRecord(output) ? stringOrNull(output.status) : null,
  };
};

/**
 * The text a command printed, read loosely enough to find a diff in it
 * (another tool's write may have been done by `git apply` or `patch`).
 * @param {ToolCallSource} part
 * @returns {string | null}
 */
export const getCommandOutputText = ({ output }) =>
  isString(output)
    ? output
    : getStringFromPaths(
        output,
        [["output"], ["text"], ["content"], ["stdout"]],
        { allowEmpty: true },
      );

// ── Search ────────────────────────────────────────────────────────────

/**
 * @typedef {object} SearchMatch
 * @property {string | null} file
 * @property {number | null} line
 * @property {string} text
 * @property {string | null} toolName  For a tool search, the tool found.
 * @property {Record<string, unknown>} raw
 */

/**
 * @typedef {object} SearchToolCall
 * @property {string | null} query
 * @property {boolean} hasOutput
 * @property {number} count
 * @property {SearchMatch[]} matches      Structured results.
 * @property {string[]} textResults       Plain-text results, one per line.
 * @property {string[]} toolReferences    Tools a tool search turned up.
 */

/** @param {unknown} output */
const getSearchResultList = (output) => {
  if (isRecord(output)) {
    for (const key of ["matches", "results", "files"]) {
      if (Array.isArray(output[key])) {
        return /** @type {unknown[]} */ (output[key]);
      }
    }
  }
  return Array.isArray(output) ? output : null;
};

/** @param {Record<string, unknown>} match */
const getMatchToolName = (match) =>
  (isString(match.tool_name) && match.tool_name) ||
  (isString(match.toolName) && match.toolName) ||
  null;

/** @param {ToolCallSource} part @returns {SearchToolCall} */
export const describeSearch = ({ input, output }) => {
  const results = getSearchResultList(output);
  const matches = (results ?? []).filter(isRecord).map((match) => ({
    file:
      (isString(match.file) && match.file) ||
      (isString(match.path) && match.path) ||
      null,
    line:
      typeof match.line === "number"
        ? match.line
        : typeof match.line_number === "number"
          ? match.line_number
          : null,
    raw: match,
    text:
      (isString(match.text) && match.text) ||
      (isString(match.preview) && match.preview) ||
      (isString(match.lineText) && match.lineText) ||
      "",
    toolName: getMatchToolName(match),
  }));
  const textResults = (
    isString(output) ? output.split(/\r?\n/) : (results ?? []).filter(isString)
  ).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && trimmed.toLowerCase() !== "no files found";
  });

  return {
    count:
      isRecord(output) && typeof output.count === "number"
        ? output.count
        : results
          ? results.length
          : textResults.length,
    hasOutput: results !== null || textResults.length > 0,
    matches,
    query: isRecord(input)
      ? (stringOrNull(input.query) ?? stringOrNull(input.pattern))
      : null,
    textResults,
    toolReferences: matches
      .map((match) => match.toolName)
      .filter((name) => name !== null),
  };
};

/**
 * Whether a tool search only looked up the direct web tools, which Dream
 * shows on their own and so need no search chip.
 * @param {ToolCallSource} part
 */
export const isDirectWebToolSearch = ({ input, output }) => {
  const isDirectWebToolName = (/** @type {string} */ name) => {
    const key = toolNameKey(name);
    return key === "webfetch" || key === "websearch";
  };
  const query = isString(input)
    ? input
    : isRecord(input)
      ? getStringFromPaths(input, [
          ["query"],
          ["pattern"],
          ["tool"],
          ["toolName"],
          ["tool_name"],
          ["name"],
        ])
      : null;
  if (query && isDirectWebToolName(query)) {
    return true;
  }

  const references = (getSearchResultList(output) ?? [])
    .map((match) =>
      isString(match)
        ? match
        : isRecord(match)
          ? getStringFromPaths(match, [["tool_name"], ["toolName"], ["name"]])
          : null,
    )
    .filter((name) => name !== null);
  return references.length > 0 && references.every(isDirectWebToolName);
};

// ── List ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} ListToolCall
 * @property {string | null} directory  As given; "." means the project.
 * @property {string | null} pattern
 * @property {string[] | null} files    Null when the output lists none.
 * @property {number} count
 */

/** @param {ToolCallSource} part @returns {ListToolCall} */
export const describeList = ({ input, output }) => {
  const list = isRecord(output)
    ? [output.files, output.matches, output.paths, output.results].find(
        Array.isArray,
      )
    : undefined;
  const files = Array.isArray(list)
    ? list
        .map((item) =>
          isString(item)
            ? item
            : isRecord(item) && isString(item.path)
              ? item.path
              : isRecord(item) && isString(item.file)
                ? item.file
                : null,
        )
        .filter((item) => item !== null)
    : null;

  return {
    count:
      files === null
        ? 0
        : isRecord(output) && typeof output.count === "number"
          ? output.count
          : files.length,
    directory: isRecord(input)
      ? (stringOrNull(input.directory) ?? stringOrNull(input.path))
      : null,
    files,
    pattern: isRecord(input) ? stringOrNull(input.pattern) : null,
  };
};

// ── Web fetch ─────────────────────────────────────────────────────────

/**
 * @typedef {object} WebFetchToolCall
 * @property {boolean} isWebSearch  A search rather than a page fetch.
 * @property {string | null} url
 * @property {string | null} query
 * @property {string | null} prompt  What the agent asked about the page.
 * @property {string | null} text    The fetched or found text.
 */

/** @param {ToolCallSource} part @returns {WebFetchToolCall} */
export const describeWebFetch = ({ input, output, toolName }) => ({
  isWebSearch: toolNameKey(toolName) === "websearch",
  prompt: getStringFromPaths(input, [["prompt"], ["query"]]),
  query: getStringFromPaths(input, [
    ["query"],
    ["search_query"],
    ["searchQuery"],
    ["input", "query"],
  ]),
  text: isString(output)
    ? output
    : getStringFromPaths(output, [
        ["content"],
        ["text"],
        ["result"],
        ["markdown"],
        ["body"],
      ]),
  url: getStringFromPaths(input, [
    ["url"],
    ["request", "url"],
    ["input", "url"],
  ]),
});

// ── Write ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} WriteToolCall
 * @property {string | null} path
 * @property {string | null} filename
 * @property {string | null} content          The file's new text, when given.
 * @property {string | null} previousContent  Its text before, when given.
 * @property {string | null} diff             A diff the agent reported.
 * @property {{ previous: string, next: string } | null} edit
 *   Replaced text, for edit-style tools that send only the changed lines.
 * @property {string | null} changeStatus     "add", "update", "delete"...
 * @property {string | null} mode             "append" for appends.
 * @property {string | null} outputMessage    What the tool said it did.
 */

const FILE_PATH_KEYS = [
  ["path"],
  ["filePath"],
  ["file_path"],
  ["filename"],
  ["name"],
  ["title"],
  ["file", "file"],
  ["file", "path"],
  ["file", "filePath"],
  ["file", "filename"],
  ["file", "name"],
];

/**
 * The first string at `paths` in any entry of a `changes` list (Codex and
 * OpenCode report file changes as one).
 * @param {unknown} value
 * @param {ReadonlyArray<readonly string[]>} paths
 * @param {{ allowEmpty?: boolean }} [options]
 */
const getFirstChangeString = (value, paths, options) => {
  if (!isRecord(value) || !Array.isArray(value.changes)) {
    return null;
  }
  for (const change of value.changes) {
    const found = getStringFromPaths(change, paths, options);
    if (found !== null) {
      return found;
    }
  }
  return null;
};

/** @param {unknown} value */
const getFirstChangePath = (value) =>
  getFirstChangeString(value, FILE_PATH_KEYS);

/** @param {unknown} value */
const getFirstChangeDiff = (value) =>
  getFirstChangeString(value, [
    ["diff"],
    ["patch"],
    ["file", "diff"],
    ["file", "patch"],
  ]);

/** @param {unknown} value */
const getFirstChangeContent = (value) =>
  getFirstChangeString(
    value,
    [
      ["content"],
      ["contents"],
      ["text"],
      ["newContent"],
      ["new_content"],
      ["newText"],
      ["new_text"],
      ["file", "content"],
      ["file", "text"],
      ["file", "newContent"],
    ],
    { allowEmpty: true },
  );

/** @param {unknown} value */
const getFirstChangePreviousContent = (value) =>
  getFirstChangeString(
    value,
    [
      ["previousContent"],
      ["previous_content"],
      ["oldContent"],
      ["old_content"],
      ["oldText"],
      ["old_text"],
      ["file", "previousContent"],
      ["file", "oldContent"],
    ],
    { allowEmpty: true },
  );

/** @param {unknown} value */
const getFirstChangeStatus = (value) =>
  getFirstChangeString(value, [
    ["status"],
    ["kind"],
    ["type"],
    ["file", "status"],
    ["file", "kind"],
  ]);

/**
 * A path named in a tool's reply ("The file src/a.ts has been updated").
 * @param {unknown} output
 */
const getFilePathFromOutputText = (output) => {
  if (!isString(output)) {
    return null;
  }
  const match = output.match(
    /(?:^|\b)(?:the\s+)?file\s+(.+?)\s+(?:has\s+been|was)\s+(?:updated|written|created)\b/i,
  );
  const rawPath = match?.[1]?.trim();
  return rawPath ? rawPath.replace(/^['"`]+|['"`.]+$/g, "") : null;
};

/** @param {unknown} input @returns {{ previous: string, next: string } | null} */
const getEdit = (input) => {
  const previous = getStringFromPaths(
    input,
    [["old_string"], ["oldString"], ["oldText"], ["old"]],
    { allowEmpty: true },
  );
  const next = getStringFromPaths(
    input,
    [["new_string"], ["newString"], ["newText"], ["new"]],
    { allowEmpty: true },
  );
  if (previous !== null && next !== null) {
    return { next, previous };
  }

  if (isRecord(input) && Array.isArray(input.edits)) {
    const join = (/** @type {string[][]} */ paths) =>
      /** @type {unknown[]} */ (input.edits)
        .map((edit) => getStringFromPaths(edit, paths, { allowEmpty: true }))
        .filter(isString)
        .join("\n");
    const editsPrevious = join([["old_string"], ["oldString"]]);
    const editsNext = join([["new_string"], ["newString"]]);
    if (editsPrevious || editsNext) {
      return { next: editsNext, previous: editsPrevious };
    }
  }

  return null;
};

/** @param {ToolCallSource} part @returns {WriteToolCall} */
export const describeWrite = ({ input, output }) => {
  const path =
    getStringFromPaths(input, [["filePath"], ...FILE_PATH_KEYS]) ??
    getStringFromPaths(output, [["filePath"], ...FILE_PATH_KEYS, ["file"]]) ??
    getFirstChangePath(input) ??
    getFirstChangePath(output) ??
    getFilePathFromOutputText(output);
  const namedFile = [
    ["filename"],
    ["name"],
    ["title"],
    ["file", "file"],
    ["file", "name"],
  ];
  const contentKeys = [
    ["content"],
    ["contents"],
    ["text"],
    ["file", "content"],
    ["file", "text"],
  ];
  const diff =
    getStringFromPaths(
      output,
      [
        ["diff"],
        ["patch"],
        ["changes", "diff"],
        ["file", "diff"],
        ["file", "patch"],
      ],
      { allowEmpty: true },
    ) ??
    getFirstChangeDiff(input) ??
    getFirstChangeDiff(output);
  const modeKeys = [["mode"], ["writeMode"], ["file", "mode"]];
  const message = isString(output)
    ? output
    : isRecord(output) && isString(output.message)
      ? output.message
      : null;

  return {
    changeStatus: getFirstChangeStatus(output) ?? getFirstChangeStatus(input),
    content:
      getStringFromPaths(input, contentKeys, { allowEmpty: true }) ??
      getFirstChangeContent(input) ??
      getFirstChangeContent(output) ??
      getStringFromPaths(output, contentKeys, { allowEmpty: true }),
    diff: diff?.trim() ? diff : null,
    edit: getEdit(input),
    filename:
      getBasename(path) ??
      getStringFromPaths(input, namedFile) ??
      getStringFromPaths(output, namedFile),
    mode:
      getStringFromPaths(input, modeKeys) ??
      getStringFromPaths(output, modeKeys),
    outputMessage: message
      ? message
          .trim()
          .replace(/^['"`]+|['"`]+$/g, "")
          .replace(/\\/g, "/")
      : null,
    path,
    previousContent:
      getStringFromPaths(
        output,
        [
          ["previousContent"],
          ["previous_content"],
          ["file", "previousContent"],
        ],
        { allowEmpty: true },
      ) ??
      getFirstChangePreviousContent(output) ??
      getFirstChangePreviousContent(input),
  };
};

// ── Agent, MCP, task output ───────────────────────────────────────────

/**
 * @typedef {object} AgentToolCall
 * @property {string | null} description  The task the agent was given.
 * @property {string | null} agentType     Its nickname, role or type.
 * @property {string | null} outputText    Its reply, without usage footers.
 */

/** @param {ToolCallSource} part @returns {AgentToolCall} */
export const describeAgent = ({ input, output }) => {
  const outputText =
    isString(output) && output.length > 0
      ? output
          .replace(/\n*<usage>[\s\S]*?<\/usage>\s*$/i, "")
          .replace(/\n*agentId:[^\n]*(?:\n|$)/i, "\n")
          .trim()
      : "";

  return {
    agentType: getStringFromPaths(input, [
      ["nickname"],
      ["agentNickname"],
      ["role"],
      ["agentRole"],
      ["subagent_type"],
      ["subagentType"],
      ["type"],
    ]),
    description: getStringFromPaths(input, [["description"]]),
    outputText: outputText || null,
  };
};

/**
 * @typedef {object} McpToolCall
 * @property {string | null} server   Null for a tool not named mcp__…__….
 * @property {string | null} command
 */

/** @param {ToolCallSource} part @returns {McpToolCall} */
export const describeMcp = ({ toolName }) => {
  const parsed = isString(toolName) ? parseMcpToolName(toolName) : null;
  return {
    command: parsed?.command ?? null,
    server: parsed?.server ?? null,
  };
};

/**
 * @typedef {object} TaskOutputToolCall
 * @property {string | null} taskId
 * @property {string | null} outputText
 */

/** @param {ToolCallSource} part @returns {TaskOutputToolCall} */
export const describeTaskOutput = ({ input, output }) => {
  const idKeys = [["task_id"], ["taskId"], ["id"]];
  return {
    outputText: isString(output) && output.length > 0 ? output : null,
    taskId:
      getStringFromPaths(input, idKeys) ?? getStringFromPaths(output, idKeys),
  };
};
