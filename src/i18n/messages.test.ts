import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { APP_LOCALES } from "./config";

// English is the source of truth. `tsc` already fails when a locale is
// missing a key (see `Messages` in messages.ts); these tests also catch what
// the type cannot: extra keys, empty strings, and a translation that renamed
// or dropped an ICU argument or rich-text tag.

const MESSAGES_DIR = path.join(import.meta.dirname, "messages");

type MessageTree = { [key: string]: string | MessageTree };

const readLocale = (locale: string): MessageTree =>
  JSON.parse(
    fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), "utf8"),
  );

/** Every message as `namespace.key` → text. */
const flatten = (
  tree: MessageTree,
  prefix = "",
  into = new Map<string, unknown>(),
) => {
  for (const [key, value] of Object.entries(tree)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      flatten(value, keyPath, into);
    } else {
      into.set(keyPath, value);
    }
  }
  return into;
};

/**
 * The argument names (`{name}`, `{count, plural, …}`) and rich-text tags
 * (`<strong>`) a message uses. Plural branches are walked for nested
 * arguments; their selectors (`=0`, `one`, `other`) are not arguments, so a
 * locale may use different branches than English.
 */
const messagePlaceholders = (message: string): string[] => {
  const found = new Set<string>();
  let index = 0;

  const readUntil = (stops: string) => {
    const start = index;
    while (index < message.length && !stops.includes(message[index])) {
      index += 1;
    }
    return message.slice(start, index).trim();
  };

  const skipSpace = () => {
    while (/\s/.test(message[index] ?? "")) {
      index += 1;
    }
  };

  // Reads text up to the `}` that closes the enclosing branch (or the end).
  const readMessage = () => {
    while (index < message.length && message[index] !== "}") {
      if (message[index] === "{") {
        index += 1;
        readArgument();
      } else {
        index += 1;
      }
    }
  };

  // Reads `name}` or `name, type}` or `name, type, selector {…} …}`.
  const readArgument = () => {
    found.add(`{${readUntil(",}")}}`);
    if (message[index] === "}") {
      index += 1;
      return;
    }
    index += 1;
    readUntil(",}");
    if (message[index] === "}") {
      index += 1;
      return;
    }
    index += 1;
    for (;;) {
      skipSpace();
      if (index >= message.length) {
        return;
      }
      if (message[index] === "}") {
        index += 1;
        return;
      }
      readUntil("{");
      index += 1;
      readMessage();
      index += 1;
    }
  };

  readMessage();
  for (const match of message.matchAll(/<(\w+)>/g)) {
    found.add(`<${match[1]}>`);
  }

  return [...found].sort();
};

const english = flatten(readLocale("en"));

test("there is exactly one message file per app locale", () => {
  const files = fs
    .readdirSync(MESSAGES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();

  assert.deepEqual(files, [...APP_LOCALES].sort());
});

test("every English message is a non-empty string", () => {
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.notEqual(String(value).trim(), "", key);
  }
});

for (const locale of APP_LOCALES.filter((item) => item !== "en")) {
  test(`${locale} has exactly the English keys`, () => {
    const messages = flatten(readLocale(locale));
    const missing = [...english.keys()].filter((key) => !messages.has(key));
    const extra = [...messages.keys()].filter((key) => !english.has(key));

    assert.deepEqual({ extra, missing }, { extra: [], missing: [] });
  });

  test(`${locale} messages are non-empty and keep English's arguments and tags`, () => {
    const messages = flatten(readLocale(locale));
    const mismatched: string[] = [];

    for (const [key, value] of messages) {
      const source = english.get(key);
      if (typeof value !== "string" || !value.trim()) {
        mismatched.push(`${key}: empty or not a string`);
        continue;
      }
      if (typeof source !== "string") {
        continue;
      }
      const expected = messagePlaceholders(source).join(" ");
      const actual = messagePlaceholders(value).join(" ");
      if (expected !== actual) {
        mismatched.push(`${key}: expected [${expected}], got [${actual}]`);
      }
    }

    assert.deepEqual(mismatched, []);
  });
}

test("placeholder extraction reads arguments, plural branches and tags", () => {
  assert.deepEqual(messagePlaceholders("Plain text"), []);
  assert.deepEqual(
    messagePlaceholders("Remove <strong>{name}</strong> from {place}."),
    ["<strong>", "{name}", "{place}"],
  );
  // Branch selectors and branch text are not arguments; `#` is not either.
  assert.deepEqual(
    messagePlaceholders(
      "{count, plural, =0 {Import} =1 {Import 1 server} other {Import # servers}}",
    ),
    ["{count}"],
  );
  // Arguments nested inside a branch are found.
  assert.deepEqual(
    messagePlaceholders(
      "{count, plural, one {# file in {folder}} other {# files in {folder}}} today",
    ),
    ["{count}", "{folder}"],
  );
  assert.deepEqual(messagePlaceholders("{count, number}"), ["{count}"]);
});
