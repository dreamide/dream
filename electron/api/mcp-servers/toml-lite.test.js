import assert from "node:assert/strict";
import { test } from "vitest";
import { parseTomlLite } from "./toml-lite.js";

test("parses codex-style mcp_servers sections", () => {
  const parsed = parseTomlLite(`
# Codex config
model = "gpt-5"

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", 'C:\\Users\\me']
env = { API_KEY = "abc", "Other-Key" = "x" }
enabled = true
startup_timeout_sec = 10.5

[mcp_servers."remote server"]
url = "https://example.com/mcp"
bearer_token_env_var = "TOKEN"
http_headers = { Authorization = "Bearer x" }

[projects."E:\\\\dev\\\\dream"]
trust_level = "trusted"
`);
  assert.deepEqual(parsed.mcp_servers, {
    filesystem: {
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me"],
      command: "npx",
      enabled: true,
      env: { API_KEY: "abc", "Other-Key": "x" },
      startup_timeout_sec: 10.5,
    },
    "remote server": {
      bearer_token_env_var: "TOKEN",
      http_headers: { Authorization: "Bearer x" },
      url: "https://example.com/mcp",
    },
  });
  assert.equal(parsed.model, "gpt-5");
  assert.deepEqual(parsed.projects, {
    "E:\\dev\\dream": { trust_level: "trusted" },
  });
});

test("handles escapes, dotted keys, multiline strings and comments", () => {
  const parsed = parseTomlLite(`
a.b.c = "line\\nbreak" # trailing comment
literal = 'no \\escape'
multi = """
first
second"""
number = 1_000
negative = -2
hex = 0xff
flag = false
empty = {}
nested = { inner = { deep = "yes" }, list = [1, 2] }
`);
  assert.deepEqual(parsed, {
    a: { b: { c: "line\nbreak" } },
    empty: {},
    flag: false,
    hex: 255,
    literal: "no \\escape",
    multi: "first\nsecond",
    negative: -2,
    nested: { inner: { deep: "yes" }, list: [1, 2] },
    number: 1000,
  });
});

test("skips malformed lines and array tables without throwing", () => {
  const parsed = parseTomlLite(`
good = "ok"
broken = "unterminated
also_good = 2

[[array_table]]
name = "ignored"

[section]
value = true
`);
  assert.equal(parsed.good, "ok");
  assert.equal(parsed.also_good, 2);
  assert.equal(parsed.array_table, undefined);
  assert.deepEqual(parsed.section, { value: true });
});

test("returns an empty object for empty input", () => {
  assert.deepEqual(parseTomlLite(""), {});
  assert.deepEqual(parseTomlLite(undefined), {});
});
