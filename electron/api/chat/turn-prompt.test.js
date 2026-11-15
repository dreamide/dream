// The Turn prompt through its interface: what a turn sends given how it
// started, in each provider form the adapters use.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { describeAttachment } from "../../shared/attachment-content.js";
import {
  buildLatestUserPrompt,
  buildReconstructedPrompt,
  buildTurnPrompt,
  chunkTextInput,
  decideTurnContent,
  getLatestUserMessage,
  RECONSTRUCTED_PROMPT_BOUND,
  serializeTurnMessage,
  withSessionHandoff,
} from "./turn-prompt.js";

const makeTextMessage = (role, text) => ({
  parts: [{ text, type: "text" }],
  role,
});

const conversation = [
  makeTextMessage("user", "One"),
  makeTextMessage("assistant", "Reply"),
  makeTextMessage("user", "Two"),
];

const notes = {
  filename: "notes.txt",
  mediaType: "text/plain",
  type: "file",
  url: `data:text/plain;base64,${Buffer.from("hello notes").toString("base64")}`,
};
const withAttachment = [
  makeTextMessage("user", "One"),
  makeTextMessage("assistant", "Reply"),
  { parts: [{ text: "Read this", type: "text" }, notes], role: "user" },
];

// The forms the adapters pass (codex-app-server.js, acp-stream.js,
// antigravity-stream.js); OpenCode's differs from Codex's only in wording.
const CODEX = {
  label: "Codex",
  runtimeDescription: "RUNTIME",
  systemPrompt: "SYS",
};
const CURSOR = {
  label: "Cursor Agent",
  runtimeDescription: "RUNTIME",
  systemPrompt: "SYS",
};
const ANTIGRAVITY = {
  label: "Antigravity",
  plain: true,
  runtimeDescription: "RUNTIME",
  systemPrompt: "SYS",
};
const CONTINUE =
  "Continue the conversation naturally and complete the user's latest request.";

const longHistory = [
  ...Array.from({ length: 10 }, (_, index) => [
    makeTextMessage("user", `Question ${index}`),
    {
      parts: [
        { text: "a".repeat(100_000), type: "text" },
        {
          input: { cmd: "cat" },
          output: "o".repeat(50_000),
          type: "tool-bash",
        },
      ],
      role: "assistant",
    },
  ]).flat(),
  makeTextMessage("user", "LATEST"),
];

const base = {
  currentTurnAttachments: "ATT",
  projectPath: "/proj",
  projectReferencesPrompt: "REFS",
  sessionHandoff: "HANDOFF",
};

describe("what a turn sends", () => {
  const rows = [
    {
      name: "resumed: the latest message, references, handoff, attachments",
      input: { ...base, form: CODEX, messages: conversation, resumed: true },
      expected: "USER:\nTwo\n\nREFS\n\nHANDOFF\n\nATT",
    },
    {
      name: "not resumed: the reconstructed history, without the handoff",
      input: { ...base, form: CODEX, messages: conversation, resumed: false },
      expected: [
        "SYS",
        "Active project: /proj",
        "RUNTIME",
        "Conversation transcript:\n\nUSER:\nOne\n\nASSISTANT:\nReply\n\nUSER:\nTwo",
        "REFS",
        "ATT",
        CONTINUE,
      ].join("\n\n"),
    },
    {
      name: "a plain provider resumed: the user's own words",
      input: {
        ...base,
        currentTurnAttachments: null,
        form: ANTIGRAVITY,
        messages: conversation,
        resumed: true,
      },
      expected: "Two\n\nREFS\n\nHANDOFF",
    },
    {
      name: "a plain provider's first turn: the message, not a transcript",
      input: {
        ...base,
        currentTurnAttachments: null,
        form: ANTIGRAVITY,
        messages: [makeTextMessage("user", "Hi")],
        resumed: false,
      },
      expected: "Hi\n\nREFS",
    },
    {
      name: "a slash-dispatched skill leads a resumed prompt",
      input: {
        ...base,
        form: CURSOR,
        messages: conversation,
        resumed: true,
        skillSlashCommand: "deploy",
      },
      expected: "/deploy USER:\nTwo\n\nREFS\n\nHANDOFF\n\nATT",
    },
    {
      name: "a slash-dispatched skill leads a reconstructed prompt",
      input: {
        ...base,
        form: CURSOR,
        messages: conversation,
        resumed: false,
        skillSlashCommand: "deploy",
      },
      check: (prompt) => {
        assert.ok(prompt.startsWith("/deploy SYS\n\nActive project: /proj"));
        assert.ok(!prompt.includes("HANDOFF"));
      },
    },
    {
      name: "a long reconstructed history is bounded, oldest first",
      input: {
        ...base,
        form: CURSOR,
        messages: longHistory,
        resumed: false,
      },
      check: (prompt) => {
        assert.ok(prompt.length <= RECONSTRUCTED_PROMPT_BOUND.maxChars);
        assert.ok(
          prompt.includes(
            "[Conversation transcript truncated to fit Cursor Agent input limits.]",
          ),
        );
        assert.ok(!prompt.includes("Question 0\n"));
        assert.ok(prompt.includes("USER:\nLATEST"));
        assert.ok(
          prompt.includes(
            "[bash output truncated to fit Cursor Agent input limits]",
          ),
        );
        assert.ok(prompt.endsWith(`REFS\n\nATT\n\n${CONTINUE}`));
      },
    },
    {
      name: "a resumed prompt is not bounded",
      input: {
        ...base,
        form: CURSOR,
        messages: [makeTextMessage("user", "x".repeat(800_000))],
        resumed: true,
      },
      check: (prompt) => assert.ok(prompt.length > 800_000),
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const prompt = buildTurnPrompt(row.input);
      if (row.check) row.check(prompt);
      else assert.equal(prompt, row.expected);
    });
  }
});

test("attachments are described by the shared rules in every form", () => {
  const description = describeAttachment(notes);
  assert.ok(description.includes("hello notes"));
  const prompts = [
    buildTurnPrompt({
      form: CODEX,
      messages: withAttachment,
      projectPath: "/p",
      resumed: true,
    }),
    buildTurnPrompt({
      form: CODEX,
      messages: withAttachment,
      projectPath: "/p",
      resumed: false,
    }),
    buildTurnPrompt({
      form: ANTIGRAVITY,
      messages: withAttachment,
      projectPath: "/p",
      resumed: true,
    }),
    buildTurnPrompt({
      form: ANTIGRAVITY,
      messages: withAttachment,
      projectPath: "/p",
      resumed: false,
    }),
  ];
  for (const prompt of prompts) {
    assert.ok(prompt.includes(`Read this\n\n${description}`), prompt);
  }
  assert.equal(
    prompts[2],
    `Read this\n\n${description}`,
    "the plain form has no role label",
  );
});

describe("the decision for a structured provider", () => {
  test("resumed: the latest user message, with the handoff in the context", () => {
    assert.deepEqual(
      decideTurnContent({
        messages: conversation,
        projectReferencesPrompt: "REFS",
        resumed: true,
        sessionHandoff: "HANDOFF",
      }),
      {
        context: "REFS\n\nHANDOFF",
        messages: [conversation[2]],
        resumed: true,
      },
    );
  });

  test("not resumed: the whole history, and the references alone", () => {
    assert.deepEqual(
      decideTurnContent({
        messages: conversation,
        projectReferencesPrompt: "REFS",
        resumed: false,
        sessionHandoff: "HANDOFF",
      }),
      { context: "REFS", messages: conversation, resumed: false },
    );
    assert.equal(
      decideTurnContent({ messages: [], resumed: false }).context,
      null,
    );
  });
});

test("a resumed prompt carries the handoff after the project references", () => {
  assert.equal(withSessionHandoff("refs", "missed"), "refs\n\nmissed");
  assert.equal(withSessionHandoff(null, "missed"), "missed");
  assert.equal(withSessionHandoff("refs", null), "refs");
  assert.equal(withSessionHandoff(null, null), null);
});

test("chunks text input by the given chunk size", () => {
  assert.deepEqual(chunkTextInput("abcdefgh", 3), ["abc", "def", "gh"]);
  assert.deepEqual(chunkTextInput("short"), ["short"]);
  assert.deepEqual(chunkTextInput(null), [""]);
});

test("finds the latest user message in a conversation", () => {
  assert.equal(getLatestUserMessage(conversation), conversation[2]);
  assert.equal(
    getLatestUserMessage([makeTextMessage("assistant", "hi")]),
    null,
  );
  assert.equal(getLatestUserMessage([]), null);
});

test("serializes text, tool, and file parts with an uppercased role prefix", () => {
  assert.equal(
    serializeTurnMessage({
      parts: [
        { text: "  Hello  ", type: "text" },
        { text: "   ", type: "text" },
      ],
      role: "user",
    }),
    "USER:\nHello",
  );
  assert.equal(
    serializeTurnMessage({
      parts: [{ input: { cmd: "ls" }, output: "ok", type: "tool-bash" }],
      role: "assistant",
    }),
    'ASSISTANT:\n[Tool bash]\ninput:\n{\n  "cmd": "ls"\n}\noutput:\nok',
  );
  assert.equal(
    serializeTurnMessage({
      parts: [{ filename: "pic.png", mediaType: "image/png", type: "file" }],
      role: "user",
    }),
    "USER:\n[Attached image: pic.png (image/png)]",
  );
  assert.equal(serializeTurnMessage({ parts: [], role: "user" }), "");
  assert.equal(serializeTurnMessage(null), "");
});

test("bounds a reconstructed prompt to maxChars", () => {
  const prompt = buildReconstructedPrompt({
    bound: { maxChars: 200 },
    messages: [
      makeTextMessage("user", "x".repeat(5000)),
      makeTextMessage("assistant", "y".repeat(5000)),
    ],
    projectPath: "/proj",
    runtimeDescription: "RUNTIME",
    systemPrompt: "SYS",
  });
  assert.ok(prompt.length <= 200);
});

test("combines the latest user message with the context and attachments", () => {
  assert.equal(buildLatestUserPrompt(conversation), "USER:\nTwo");
  assert.equal(
    buildLatestUserPrompt(conversation, "ATTACHMENTS", "REFERENCES"),
    "USER:\nTwo\n\nREFERENCES\n\nATTACHMENTS",
  );
  assert.equal(
    buildLatestUserPrompt([], "ATTACHMENTS", "REFERENCES"),
    "REFERENCES\n\nATTACHMENTS",
  );
});

test("treats a CSV as text even when it is labelled as a spreadsheet", () => {
  const serialized = serializeTurnMessage({
    parts: [
      {
        filename: "mrr-waterfall.csv",
        mediaType: "application/vnd.ms-excel",
        type: "file",
        url: `data:application/vnd.ms-excel;base64,${Buffer.from("a,b\n1,2\n").toString("base64")}`,
      },
    ],
    role: "user",
  });
  assert.ok(serialized.includes("a,b\n1,2"));
});

test("does not treat a real spreadsheet as text", () => {
  const serialized = serializeTurnMessage({
    parts: [
      {
        filename: "report.xlsx",
        mediaType: "application/vnd.ms-excel",
        type: "file",
        url: `data:application/vnd.ms-excel;base64,${Buffer.from("PK-binary").toString("base64")}`,
      },
    ],
    role: "user",
  });
  assert.equal(serialized.includes("PK-binary"), false);
});
