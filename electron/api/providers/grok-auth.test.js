import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { createGrokAuth } from "./grok-auth.js";

const HOME = path.join("/home", "me");
const AUTH_FILE = path.join(HOME, ".grok", "auth.json");
const NOW = Date.parse("2026-11-17T12:00:00Z");
const FUTURE = "2026-12-01T00:00:00Z";
const PAST = "2026-11-01T00:00:00Z";

/** A Grok login over a fake file system; `file` is auth.json's contents. */
const setup = ({ env = {}, file } = {}) => {
  const read = [];
  const auth = createGrokAuth({
    env,
    homedir: () => HOME,
    now: () => NOW,
    readFile: async (filePath) => {
      read.push(filePath);
      if (file === undefined) throw new Error("ENOENT");
      return typeof file === "string" ? file : JSON.stringify(file);
    },
  });
  return { auth, read };
};

const chosen = async (file) => (await setup({ file }).auth.read())?.scope;

test("auth.json is read from ~/.grok, or from $GROK_HOME", async () => {
  const home = setup({ file: {} });
  await home.auth.read();
  assert.deepEqual(home.read, [AUTH_FILE]);

  const moved = setup({ env: { GROK_HOME: "  /opt/grok  " }, file: {} });
  await moved.auth.read();
  assert.deepEqual(moved.read, [path.join("/opt/grok", "auth.json")]);

  const blank = setup({ env: { GROK_HOME: "   " }, file: {} });
  await blank.auth.read();
  assert.deepEqual(blank.read, [AUTH_FILE]);
});

test("a missing, unparseable or non-object file, or one with no token, is no login", async () => {
  for (const file of [undefined, "{nope", "null", "42", "{}"]) {
    assert.equal(await setup({ file }).auth.read(), null, String(file));
  }
  assert.equal(
    await setup({
      file: { a: { key: "  " }, b: { access_token: 5 }, c: null, d: "text" },
    }).auth.read(),
    null,
  );
});

test("the token is the trimmed key, else the access token; the user id is optional", async () => {
  const { auth } = setup({
    file: {
      only: { access_token: " at ", key: "  ", user_id: " u-1 " },
    },
  });
  assert.deepEqual(await auth.read(), {
    accessToken: "at",
    score: 8,
    scope: "only",
    userId: "u-1",
  });

  const camel = await setup({
    file: { s: { key: "k", userId: "u-2" } },
  }).auth.read();
  assert.equal(camel.accessToken, "k");
  assert.equal(camel.userId, "u-2");

  const none = await setup({ file: { s: { key: "k" } } }).auth.read();
  assert.equal(none.userId, "");
});

test("an unexpired credential beats every scope and mode", async () => {
  assert.equal(
    await chosen({
      "https://auth.x.ai::expired": {
        auth_mode: "oidc",
        expires_at: PAST,
        key: "a",
      },
      plain: { expires_at: FUTURE, key: "b" },
    }),
    "plain",
  );
});

test("among unexpired ones, auth.x.ai beats accounts.x.ai with oidc, which beats oidc alone", async () => {
  const xai = { key: "a" };
  const accountsOidc = { auth_mode: "OIDC", key: "b" };
  const oidcOnly = { authMode: "oidc", key: "c" };
  const plain = { key: "d" };

  assert.equal(
    await chosen({
      plain,
      oidc: oidcOnly,
      "https://accounts.x.ai/x": accountsOidc,
      "https://auth.x.ai::abc": xai,
    }),
    "https://auth.x.ai::abc",
  );
  assert.equal(
    await chosen({
      plain,
      oidc: oidcOnly,
      "https://accounts.x.ai/x": accountsOidc,
    }),
    "https://accounts.x.ai/x",
  );
  assert.equal(await chosen({ plain, oidc: oidcOnly }), "oidc");
  // auth.x.ai counts only as a prefix.
  assert.equal(
    await chosen({ "x https://auth.x.ai::": { key: "a" }, oidc: oidcOnly }),
    "oidc",
  );
});

test("the score adds up each rule", async () => {
  const score = async (scope, entry) =>
    (await setup({ file: { [scope]: entry } }).auth.read()).score;

  assert.equal(await score("plain", { expires_at: PAST, key: "k" }), 0);
  assert.equal(await score("plain", { key: "k" }), 8);
  assert.equal(await score("accounts.x.ai", { expires_at: PAST, key: "k" }), 2);
  assert.equal(
    await score("https://auth.x.ai::1", {
      auth_mode: "oidc",
      expires_at: PAST,
      key: "k",
    }),
    5,
  );
  assert.equal(
    await score("https://auth.x.ai::accounts.x.ai", {
      auth_mode: "oidc",
      key: "k",
    }),
    13,
  );
});

test("an expiry is a date, seconds or milliseconds, and expires at the moment itself", async () => {
  const score = async (expiry) =>
    (await setup({ file: { s: { expiresAt: expiry, key: "k" } } }).auth.read())
      .score;

  assert.equal(await score(NOW / 1000 - 1), 0, "seconds, past");
  assert.equal(await score(NOW / 1000 + 60), 8, "seconds, future");
  assert.equal(await score(NOW), 0, "milliseconds, now");
  assert.equal(await score(NOW + 1), 8, "milliseconds, future");
  assert.equal(await score(new Date(NOW).toISOString()), 0, "a date, now");
  for (const never of [null, 0, -5, "", "not a date"]) {
    assert.equal(await score(never), 8, String(never));
  }
});

test("on a tie, the credential written first is chosen", async () => {
  assert.equal(
    await chosen({ second: { key: "b" }, first: { key: "a" } }),
    "second",
  );
  assert.equal(
    await chosen({
      "accounts.x.ai/1": { expires_at: PAST, key: "a" },
      "accounts.x.ai/2": { expires_at: PAST, key: "b" },
    }),
    "accounts.x.ai/1",
  );
});

test("when every credential has expired, the best of them is still chosen", async () => {
  const credentials = await setup({
    file: {
      old: { expires_at: PAST, key: "a" },
      "https://auth.x.ai::old": { expires_at: PAST, key: "b" },
    },
  }).auth.read();
  assert.equal(credentials.scope, "https://auth.x.ai::old");
  assert.equal(credentials.accessToken, "b");
  assert.equal(credentials.score, 4);
});
