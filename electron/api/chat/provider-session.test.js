// The Provider session of a turn, through its interface: what it tells the
// adapter, what the message records once the adapter reports, and what it
// keeps for the next turn. The capability rows are the real ones.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { getProviderCapabilities } from "../../shared/provider-capabilities.js";
import {
  startProviderSession,
  withSessionHandoff,
} from "./provider-session.js";
import {
  prepareTurnTranscript,
  transcriptFingerprint,
} from "./turn-transcript.js";

const message = (id, role, text, extra = {}) => ({
  id,
  role,
  parts: [{ type: "text", text }],
  ...extra,
});
const prefix = [
  message("1", "user", "start"),
  message("2", "assistant", "done"),
];
const savedSession = (overrides = {}) => ({
  remoteConversationId: "native",
  remoteConversationModel: "m",
  remoteConversationModelSpeed: "standard",
  remoteConversationProjectPath: "/work",
  lastMessageId: "2",
  fingerprint: transcriptFingerprint(prefix),
  ...overrides,
});

const createCatalog = ({ session = null, chat = { id: "c" } } = {}) => {
  const saved = [];
  const changes = [];
  return {
    saved,
    changes,
    providerSession: vi.fn(async () => session),
    getChat: async () => chat,
    saveProviderSession: async (payload) => {
      saved.push(payload);
      return true;
    },
    applyChanges: async (change, options) => {
      changes.push([change, options]);
    },
  };
};

const providerRecord = (id, extra = {}) => ({
  id,
  ...getProviderCapabilities(id),
  ...extra,
});

const start = ({
  catalog = createCatalog(),
  provider = providerRecord("anthropic"),
  messages,
  ...options
}) =>
  startProviderSession({
    catalog,
    chatId: "c",
    provider,
    messages,
    transcript: prepareTurnTranscript(messages),
    projectPath: "/work",
    model: "m",
    modelSpeed: "standard",
    ...options,
  });

describe("resuming a saved session", () => {
  test("a chat's first turn starts fresh and records nothing about it", async () => {
    const session = await start({ messages: [message("1", "user", "hi")] });
    assert.equal(session.resumeSessionId, null);
    assert.equal(session.handoff, null);
    assert.deepEqual(session.started({ resumed: false }), {});
  });

  test("an unchanged covered prefix resumes, and records that it did", async () => {
    const session = await start({
      catalog: createCatalog({ session: savedSession() }),
      messages: [...prefix, message("3", "user", "next")],
    });
    assert.equal(session.resumeSessionId, "native");
    assert.equal(session.handoff, null);
    assert.deepEqual(session.started({ resumed: true }), {
      contextTransfer: { strategy: "resumed" },
    });
  });

  test("returning to a provider hands off only what it missed", async () => {
    const session = await start({
      catalog: createCatalog({ session: savedSession() }),
      messages: [
        ...prefix,
        message("3", "user", "change"),
        message("4", "assistant", "changed"),
        message("5", "user", "continue"),
      ],
    });
    assert.equal(session.resumeSessionId, "native");
    assert.match(session.handoff, /changed/);
    assert.doesNotMatch(session.handoff, /continue|user: start/);
    assert.deepEqual(session.started({ resumed: true }), {
      contextTransfer: { strategy: "delta", afterMessageId: "2" },
    });
  });

  test("a probe that fails records the reconstruction that followed, with its reason", async () => {
    const session = await start({
      catalog: createCatalog({ session: savedSession() }),
      messages: [
        ...prefix,
        message("3", "assistant", "elsewhere"),
        message("4", "user", "continue"),
      ],
    });
    assert.ok(session.handoff);
    assert.deepEqual(
      session.started({ resumed: false, reason: "The session is gone." }),
      {
        contextTransfer: {
          strategy: "reconstructed",
          reason: "The session is gone.",
        },
      },
    );
  });

  test("missed tool results are handed off; missed binary attachments reconstruct", async () => {
    const tools = {
      id: "tools",
      role: "assistant",
      parts: [
        {
          type: "tool-readFile",
          toolCallId: "read",
          input: { path: "README.md" },
          output: "Important context",
          state: "output-available",
        },
      ],
    };
    const catalog = createCatalog({ session: savedSession() });
    const latest = message("latest", "user", "Continue");
    assert.match(
      (await start({ catalog, messages: [...prefix, tools, latest] })).handoff,
      /Important context/,
    );
    const withImage = {
      ...tools,
      parts: [
        ...tools.parts,
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,AA==",
        },
      ],
    };
    const session = await start({
      catalog,
      messages: [...prefix, withImage, latest],
    });
    assert.equal(session.resumeSessionId, null);
    assert.deepEqual(session.started({ resumed: false }), {
      contextTransfer: { strategy: "reconstructed" },
    });
  });

  test("edited, rolled back, oversized and relocated histories never resume stale context", async () => {
    const catalog = createCatalog({ session: savedSession() });
    for (const messages of [
      [prefix[0]],
      [
        prefix[0],
        message("2", "assistant", "edited"),
        message("3", "user", "next"),
      ],
      [
        ...prefix,
        message("3", "assistant", "x".repeat(32_001)),
        message("4", "user", "next"),
      ],
    ])
      assert.equal((await start({ catalog, messages })).resumeSessionId, null);
    assert.equal(
      (
        await start({
          catalog,
          messages: [...prefix, message("3", "user", "next")],
          projectPath: "/other",
        })
      ).resumeSessionId,
      null,
    );
  });

  test("model and speed changes keep a session only where the provider switches models in it", async () => {
    const messages = [...prefix, message("3", "user", "next")];
    const resumes = async (id) =>
      (
        await start({
          catalog: createCatalog({ session: savedSession() }),
          provider: providerRecord(id),
          messages,
          model: "other",
          modelSpeed: "fast",
        })
      ).resumeSessionId;
    for (const id of ["openai", "anthropic", "opencode", "antigravity"])
      assert.equal(await resumes(id), "native", id);
    for (const id of ["cursor", "grok"])
      assert.equal(await resumes(id), null, id);

    // A session saved before speeds were recorded counts as standard speed.
    const legacy = createCatalog({
      session: savedSession({ remoteConversationModelSpeed: null }),
    });
    const grok = providerRecord("grok");
    assert.equal(
      (await start({ catalog: legacy, provider: grok, messages }))
        .resumeSessionId,
      "native",
    );
    assert.equal(
      (
        await start({
          catalog: legacy,
          provider: grok,
          messages,
          modelSpeed: "fast",
        })
      ).resumeSessionId,
      null,
    );
  });

  test("a provider whose tools are fixed at session start resumes only a session with this turn's tools", async () => {
    const messages = [...prefix, message("3", "user", "next")];
    const resumes = async (id, session) =>
      (
        await start({
          catalog: createCatalog({ session }),
          provider: providerRecord(id),
          messages,
          orchestrationTools: true,
        })
      ).resumeSessionId;
    assert.equal(await resumes("openai", savedSession()), null);
    assert.equal(
      await resumes("openai", savedSession({ orchestrationToolsVersion: 1 })),
      "native",
    );
    assert.equal(await resumes("anthropic", savedSession()), "native");
  });
});

describe("forking a branch's source session", () => {
  const source = message("source", "assistant", "answer", {
    metadata: {
      provider: "anthropic",
      remoteConversationId: "parent",
      remoteConversationProjectPath: "/work",
      nativeMessageId: "boundary",
    },
  });
  const branched = [
    message("1", "user", "ask"),
    source,
    message("3", "user", "and"),
  ];
  const branchCatalog = () =>
    createCatalog({ chat: { id: "c", branchedFrom: { messageId: "source" } } });

  test("a branch's first turn resumes a native fork at the source message", async () => {
    const fork = vi.fn(async () => "child");
    const session = await start({
      catalog: branchCatalog(),
      provider: providerRecord("anthropic", { fork }),
      messages: branched,
      permissionMode: "ask",
    });
    assert.equal(session.resumeSessionId, "child");
    assert.equal(fork.mock.calls[0][0].source, source.metadata);
    assert.equal(fork.mock.calls[0][0].projectPath, "/work");
    assert.deepEqual(session.started({ resumed: true }), {
      contextTransfer: { strategy: "native-fork", sourceMessageId: "source" },
    });
  });

  test("a failed fork reconstructs and records why", async () => {
    const session = await start({
      catalog: branchCatalog(),
      provider: providerRecord("anthropic", {
        fork: async () => {
          throw new Error("Provider did not create an independent fork.");
        },
      }),
      messages: branched,
    });
    assert.equal(session.resumeSessionId, null);
    assert.deepEqual(session.started({ resumed: false }), {
      contextTransfer: {
        strategy: "reconstructed",
        reason: "Provider did not create an independent fork.",
      },
    });
  });

  test("a stopped turn does not fork", async () => {
    const fork = vi.fn(async () => "child");
    const controller = new AbortController();
    controller.abort();
    const session = await start({
      catalog: branchCatalog(),
      provider: providerRecord("anthropic", { fork }),
      messages: branched,
      signal: controller.signal,
    });
    assert.equal(fork.mock.calls.length, 0);
    assert.equal(
      session.started({ resumed: false }).contextTransfer.reason,
      "Turn stopped.",
    );
  });

  test("only a source this provider made, in this project, with this turn's tools, is forked", async () => {
    const fork = vi.fn(async () => "child");
    const forks = async (provider, options = {}) =>
      (
        await start({
          catalog: branchCatalog(),
          provider: providerRecord(provider, { fork }),
          messages: branched,
          ...options,
        })
      ).resumeSessionId;
    assert.equal(await forks("openai"), null);
    assert.equal(await forks("anthropic", { projectPath: "/other" }), null);
    assert.equal(fork.mock.calls.length, 0);

    source.metadata.provider = "openai";
    try {
      assert.equal(await forks("openai", { orchestrationTools: true }), null);
      assert.equal(fork.mock.calls.length, 0);
      assert.equal(await forks("openai"), "child");
    } finally {
      source.metadata.provider = "anthropic";
    }
  });
});

describe("keeping the session a turn reported", () => {
  const messages = [message("1", "user", "hi")];
  const answer = message("2", "assistant", "hello", {
    metadata: {
      remoteConversationId: " native ",
      remoteConversationModel: "m",
      remoteConversationModelSpeed: "fast",
      remoteConversationProjectPath: "/work",
      orchestrationToolsVersion: 1,
    },
  });

  test("saves the session with the transcript it covers and mirrors it on the chat row", async () => {
    const catalog = createCatalog({ chat: { id: "c", title: "Chat" } });
    const session = await start({ catalog, messages });
    await session.record(answer);
    assert.deepEqual(catalog.saved, [
      {
        chatId: "c",
        provider: "anthropic",
        session: {
          remoteConversationId: "native",
          remoteConversationModel: "m",
          remoteConversationModelSpeed: "fast",
          remoteConversationProjectPath: "/work",
          lastMessageId: "2",
          fingerprint: transcriptFingerprint([...messages, answer]),
          orchestrationToolsVersion: 1,
        },
      },
    ]);
    assert.deepEqual(catalog.changes, [
      [
        {
          chats: [
            {
              id: "c",
              title: "Chat",
              remoteConversationId: "native",
              remoteConversationModel: "m",
              remoteConversationModelSpeed: "fast",
              remoteConversationProjectPath: "/work",
            },
          ],
        },
        { origin: "host" },
      ],
    ]);
  });

  test("a chat row already naming the session is left alone", async () => {
    const catalog = createCatalog({
      chat: { id: "c", remoteConversationId: "native" },
    });
    await (await start({ catalog, messages })).record(answer);
    assert.equal(catalog.saved.length, 1);
    assert.equal(catalog.changes.length, 0);
  });

  test("nothing is kept for a turn without a session, or a chat that is gone", async () => {
    const catalog = createCatalog();
    await (await start({ catalog, messages })).record(
      message("2", "assistant", "x"),
    );
    const gone = createCatalog({ chat: null });
    await (await start({ catalog: gone, messages })).record(answer);
    assert.equal(catalog.saved.length + gone.saved.length, 0);
    assert.equal(catalog.changes.length + gone.changes.length, 0);
  });

  test("without a catalog there is nothing to resume, record or keep", async () => {
    const session = await start({
      catalog: null,
      messages: [...prefix, message("3", "user", "next")],
    });
    assert.equal(session.resumeSessionId, null);
    assert.deepEqual(session.started({ resumed: false }), {});
    await session.record(answer);
  });
});

test("a resumed prompt carries the handoff after the project references", () => {
  assert.equal(withSessionHandoff("refs", "missed"), "refs\n\nmissed");
  assert.equal(withSessionHandoff(null, "missed"), "missed");
  assert.equal(withSessionHandoff("refs", null), "refs");
  assert.equal(withSessionHandoff(null, null), null);
});
