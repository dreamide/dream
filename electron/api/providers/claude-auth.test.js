import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { createClaudeAuth } from "./claude-auth.js";

const HOME = path.join("/home", "me");
const DOT_FILE = path.join(HOME, ".claude", ".credentials.json");
const PLAIN_FILE = path.join(HOME, ".claude", "credentials.json");
const NOW = 1_800_000_000_000;

const stored = (accessToken, refreshToken, extra = {}) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, scopes: ["user:inference"] },
    ...extra,
  });

const refusal = (status) =>
  Object.assign(new Error(`Claude usage request failed (${status}).`), {
    status,
  });

/**
 * A Claude login over fakes. `files` maps a path to its contents, `keychain`
 * a service to what `security` prints (an Error is thrown), `tokens` is what
 * the token endpoint answers.
 */
const setup = ({
  env = { USER: "me" },
  files = {},
  keychain = {},
  platform = "linux",
  tokens = {
    body: {
      access_token: " new-access ",
      expires_in: 3600,
      refresh_token: "new-refresh",
    },
    ok: true,
    status: 200,
  },
} = {}) => {
  const calls = { execFile: [], fetch: [], readFile: [], writeFile: [] };
  const auth = createClaudeAuth({
    env,
    execFile: async (command, args) => {
      calls.execFile.push([command, ...args]);
      if (args[0] === "add-generic-password") return { stdout: "" };
      const answer = keychain[args[2]];
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error("The specified item could not be found.");
      }
      return { stdout: answer };
    },
    fetch: async (url, init) => {
      calls.fetch.push({ init, url });
      return {
        json: async () => tokens.body,
        ok: tokens.ok,
        status: tokens.status,
      };
    },
    homedir: () => HOME,
    now: () => NOW,
    platform,
    readFile: async (filePath) => {
      calls.readFile.push(filePath);
      if (!(filePath in files)) throw new Error("ENOENT");
      return files[filePath];
    },
    writeFile: async (filePath, contents) => {
      calls.writeFile.push([filePath, contents]);
    },
  });
  return { auth, calls };
};

// Reading

test("off macOS, the keychain is not asked and .credentials.json is read first", async () => {
  const { auth, calls } = setup({
    files: {
      [DOT_FILE]: stored(" dot-access ", " dot-refresh "),
      [PLAIN_FILE]: stored("plain-access", "plain-refresh"),
    },
    keychain: { "Claude Code-credentials": stored("kc", "kc") },
    platform: "win32",
  });

  const credentials = await auth.read();

  assert.equal(calls.execFile.length, 0);
  assert.deepEqual(calls.readFile, [DOT_FILE]);
  assert.equal(credentials.accessToken, "dot-access");
  assert.equal(credentials.refreshToken, "dot-refresh");
  assert.deepEqual(credentials.storage, { path: DOT_FILE, type: "file" });
  assert.deepEqual(
    credentials.parsed,
    JSON.parse(stored(" dot-access ", " dot-refresh ")),
  );
});

test("without .credentials.json, credentials.json is read", async () => {
  const { auth, calls } = setup({
    files: { [PLAIN_FILE]: stored("plain-access", "plain-refresh") },
  });

  const credentials = await auth.read();

  assert.deepEqual(calls.readFile, [DOT_FILE, PLAIN_FILE]);
  assert.equal(credentials.accessToken, "plain-access");
  assert.deepEqual(credentials.storage, { path: PLAIN_FILE, type: "file" });
});

test("a file that is not JSON, or lacks either token, is passed over", async () => {
  for (const unusable of [
    "{not json",
    stored("access", ""),
    stored("  ", "refresh"),
    JSON.stringify({ other: true }),
  ]) {
    const { auth } = setup({
      files: {
        [DOT_FILE]: unusable,
        [PLAIN_FILE]: stored("plain-access", "plain-refresh"),
      },
    });
    assert.equal((await auth.read())?.accessToken, "plain-access", unusable);
  }
});

test("with no usable credentials anywhere, there are none", async () => {
  assert.equal(await setup().auth.read(), null);
  assert.equal(
    await setup({
      files: { [DOT_FILE]: "{}", [PLAIN_FILE]: stored("", "") },
      keychain: { "Claude Code": "" },
      platform: "darwin",
    }).auth.read(),
    null,
  );
});

test("on macOS, the keychain's two services are asked before any file", async () => {
  const { auth, calls } = setup({
    files: { [DOT_FILE]: stored("file-access", "file-refresh") },
    keychain: { "Claude Code-credentials": stored("kc-access", "kc-refresh") },
    platform: "darwin",
  });

  const credentials = await auth.read();

  assert.deepEqual(calls.execFile, [
    [
      "security",
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ],
  ]);
  assert.deepEqual(calls.readFile, []);
  assert.equal(credentials.accessToken, "kc-access");
  assert.deepEqual(credentials.storage, {
    service: "Claude Code-credentials",
    type: "keychain",
  });
});

test("on macOS, a missing, empty, unparseable or tokenless service is passed over", async () => {
  const second = setup({
    keychain: {
      "Claude Code": `  ${stored("legacy-access", "legacy-refresh")}\n`,
      "Claude Code-credentials": new Error("not found"),
    },
    platform: "darwin",
  });
  const legacy = await second.auth.read();
  assert.equal(legacy.accessToken, "legacy-access");
  assert.deepEqual(legacy.storage, {
    service: "Claude Code",
    type: "keychain",
  });

  for (const first of ["  \n", "{oops", stored("access", "")]) {
    const { auth } = setup({
      keychain: {
        "Claude Code": stored("legacy-access", "legacy-refresh"),
        "Claude Code-credentials": first,
      },
      platform: "darwin",
    });
    assert.equal((await auth.read())?.accessToken, "legacy-access", first);
  }

  const toFiles = setup({
    files: { [PLAIN_FILE]: stored("file-access", "file-refresh") },
    platform: "darwin",
  });
  assert.equal((await toFiles.auth.read()).accessToken, "file-access");
  assert.deepEqual(
    toFiles.calls.execFile.map((call) => call[3]),
    ["Claude Code-credentials", "Claude Code"],
  );
  assert.deepEqual(toFiles.calls.readFile, [DOT_FILE, PLAIN_FILE]);
});

// Refreshing

const fileLogin = async (overrides = {}) => {
  const fakes = setup({
    files: {
      [DOT_FILE]: stored("old-access", "old-refresh", { mcpOAuth: { x: 1 } }),
    },
    ...overrides,
  });
  const credentials = await fakes.auth.read();
  return { ...fakes, credentials };
};

test("a request that succeeds uses the stored token and refreshes nothing", async () => {
  const { auth, calls, credentials } = await fileLogin();
  const tokens = [];

  const answer = await auth.withAccessToken(credentials, async (token) => {
    tokens.push(token);
    return "usage";
  });

  assert.equal(answer, "usage");
  assert.deepEqual(tokens, ["old-access"]);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.writeFile.length, 0);
});

for (const status of [401, 429]) {
  test(`a ${status} refreshes the token, writes it back to the file and asks again`, async () => {
    const { auth, calls, credentials } = await fileLogin();
    const tokens = [];

    const answer = await auth.withAccessToken(credentials, async (token) => {
      tokens.push(token);
      if (tokens.length === 1) throw refusal(status);
      return "usage";
    });

    assert.equal(answer, "usage");
    assert.deepEqual(tokens, ["old-access", "new-access"]);

    assert.equal(calls.fetch.length, 1);
    const [{ init, url }] = calls.fetch;
    assert.equal(url, "https://console.anthropic.com/v1/oauth/token");
    assert.equal(init.method, "POST");
    assert.equal(init.headers, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(init.body instanceof URLSearchParams);
    assert.equal(
      init.body.toString(),
      "client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&grant_type=refresh_token&refresh_token=old-refresh",
    );

    assert.equal(calls.writeFile.length, 1);
    const [filePath, contents] = calls.writeFile[0];
    assert.equal(filePath, DOT_FILE);
    // The whole document is kept, in its order; expiresAt is added last.
    assert.equal(
      contents,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          scopes: ["user:inference"],
          expiresAt: NOW + 3_600_000,
        },
        mcpOAuth: { x: 1 },
      }),
    );
  });
}

test("any other failure is passed on without a refresh", async () => {
  for (const failure of [
    refusal(403),
    refusal(500),
    new Error("offline"),
    "text",
  ]) {
    const { auth, calls, credentials } = await fileLogin();
    let asked = 0;
    await assert.rejects(
      auth.withAccessToken(credentials, async () => {
        asked += 1;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(asked, 1);
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.writeFile.length, 0);
  }
});

test("keychain credentials are written back with security, under $USER or claude", async () => {
  for (const [env, account] of [
    [{ USER: "mike" }, "mike"],
    [{}, "claude"],
  ]) {
    const { auth, calls } = setup({
      env,
      keychain: { "Claude Code": stored("old-access", "old-refresh") },
      platform: "darwin",
    });
    const credentials = await auth.read();
    calls.execFile.length = 0;

    await auth.withAccessToken(credentials, async (token) => {
      if (token === "old-access") throw refusal(401);
      return "usage";
    });

    assert.equal(calls.writeFile.length, 0);
    assert.deepEqual(calls.execFile, [
      [
        "security",
        "add-generic-password",
        "-U",
        "-a",
        account,
        "-s",
        "Claude Code",
        "-w",
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "new-access",
            refreshToken: "new-refresh",
            scopes: ["user:inference"],
            expiresAt: NOW + 3_600_000,
          },
        }),
      ],
    ]);
  }
});

test("a refused refresh fails the request, writes nothing and does not ask again", async () => {
  const { auth, calls, credentials } = await fileLogin({
    tokens: { body: {}, ok: false, status: 400 },
  });
  let asked = 0;

  await assert.rejects(
    auth.withAccessToken(credentials, async () => {
      asked += 1;
      throw refusal(401);
    }),
    { message: "Claude token refresh failed (400)." },
  );
  assert.equal(asked, 1);
  assert.equal(calls.writeFile.length, 0);
});

test("a refresh answer missing a token or a numeric expiry is refused", async () => {
  for (const body of [
    { expires_in: 3600, refresh_token: "r" },
    { access_token: " ", expires_in: 3600, refresh_token: "r" },
    { access_token: "a", expires_in: 3600 },
    { access_token: "a", expires_in: "soon", refresh_token: "r" },
  ]) {
    const { auth, calls, credentials } = await fileLogin({
      tokens: { body, ok: true, status: 200 },
    });
    await assert.rejects(
      auth.withAccessToken(credentials, async () => {
        throw refusal(429);
      }),
      { message: "Claude token refresh returned incomplete credentials." },
    );
    assert.equal(calls.writeFile.length, 0);
  }
});

test("a failed write-back fails the request before it is asked again", async () => {
  const { credentials } = await fileLogin();
  const failing = createClaudeAuth({
    fetch: async () => ({
      json: async () => ({
        access_token: "a",
        expires_in: 1,
        refresh_token: "r",
      }),
      ok: true,
      status: 200,
    }),
    now: () => NOW,
    writeFile: async () => {
      throw new Error("EACCES");
    },
  });
  let asked = 0;

  await assert.rejects(
    failing.withAccessToken(credentials, async () => {
      asked += 1;
      throw refusal(401);
    }),
    { message: "EACCES" },
  );
  assert.equal(asked, 1);
});

test("the request after a refresh is not refreshed again when it fails", async () => {
  const { auth, calls, credentials } = await fileLogin();
  let asked = 0;

  await assert.rejects(
    auth.withAccessToken(credentials, async () => {
      asked += 1;
      throw refusal(401);
    }),
    { message: "Claude usage request failed (401)." },
  );
  assert.equal(asked, 2);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.writeFile.length, 1);
});
