/**
 * Minimal TOML reader sufficient for `~/.codex/config.toml` MCP sections.
 *
 * Supports: comments, `[a.b]` / `["quoted".key]` table headers, basic and
 * literal strings, string/number/boolean arrays, inline tables, booleans,
 * integers and floats. Unsupported constructs are skipped rather than
 * throwing, so a partially understood file still yields the parts we need.
 */

const isBareKeyChar = (char) => /[A-Za-z0-9_-]/.test(char);

const createCursor = (text) => ({ index: 0, text });

const peek = (cursor, offset = 0) => cursor.text[cursor.index + offset] ?? "";

const skipInlineWhitespace = (cursor) => {
  while (peek(cursor) === " " || peek(cursor) === "\t") {
    cursor.index += 1;
  }
};

const skipWhitespaceAndComments = (cursor) => {
  for (;;) {
    const char = peek(cursor);
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      cursor.index += 1;
    } else if (char === "#") {
      while (cursor.index < cursor.text.length && peek(cursor) !== "\n") {
        cursor.index += 1;
      }
    } else {
      return;
    }
  }
};

const UNESCAPES = {
  '"': '"',
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const readBasicString = (cursor, multiline) => {
  const quote = multiline ? '"""' : '"';
  cursor.index += quote.length;
  if (multiline && peek(cursor) === "\n") {
    cursor.index += 1;
  }
  let result = "";
  while (cursor.index < cursor.text.length) {
    if (cursor.text.startsWith(quote, cursor.index)) {
      cursor.index += quote.length;
      return result;
    }
    const char = peek(cursor);
    if (char === "\\") {
      const next = peek(cursor, 1);
      if (next === "u" || next === "U") {
        const length = next === "u" ? 4 : 8;
        const hex = cursor.text.slice(
          cursor.index + 2,
          cursor.index + 2 + length,
        );
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor.index += 2 + length;
      } else if (multiline && (next === "\n" || next === "\r")) {
        cursor.index += 1;
        skipWhitespaceAndComments(cursor);
      } else {
        result += UNESCAPES[next] ?? next;
        cursor.index += 2;
      }
      continue;
    }
    if (!multiline && (char === "\n" || char === "\r")) {
      throw new Error("Unterminated string");
    }
    result += char;
    cursor.index += 1;
  }
  throw new Error("Unterminated string");
};

const readLiteralString = (cursor, multiline) => {
  const quote = multiline ? "'''" : "'";
  cursor.index += quote.length;
  if (multiline && peek(cursor) === "\n") {
    cursor.index += 1;
  }
  const end = cursor.text.indexOf(quote, cursor.index);
  if (
    end === -1 ||
    (!multiline && cursor.text.slice(cursor.index, end).includes("\n"))
  ) {
    throw new Error("Unterminated string");
  }
  const result = cursor.text.slice(cursor.index, end);
  cursor.index = end + quote.length;
  return result;
};

const readKey = (cursor) => {
  const parts = [];
  for (;;) {
    skipInlineWhitespace(cursor);
    const char = peek(cursor);
    if (char === '"') {
      parts.push(readBasicString(cursor, false));
    } else if (char === "'") {
      parts.push(readLiteralString(cursor, false));
    } else {
      let bare = "";
      while (isBareKeyChar(peek(cursor))) {
        bare += peek(cursor);
        cursor.index += 1;
      }
      if (!bare) {
        throw new Error("Expected key");
      }
      parts.push(bare);
    }
    skipInlineWhitespace(cursor);
    if (peek(cursor) === ".") {
      cursor.index += 1;
      continue;
    }
    return parts;
  }
};

const readValue = (cursor) => {
  skipInlineWhitespace(cursor);
  const char = peek(cursor);
  if (char === '"') {
    return readBasicString(cursor, cursor.text.startsWith('"""', cursor.index));
  }
  if (char === "'") {
    return readLiteralString(
      cursor,
      cursor.text.startsWith("'''", cursor.index),
    );
  }
  if (char === "[") {
    cursor.index += 1;
    const items = [];
    for (;;) {
      skipWhitespaceAndComments(cursor);
      if (peek(cursor) === "]") {
        cursor.index += 1;
        return items;
      }
      items.push(readValue(cursor));
      skipWhitespaceAndComments(cursor);
      if (peek(cursor) === ",") {
        cursor.index += 1;
      } else if (peek(cursor) !== "]") {
        throw new Error("Expected , or ] in array");
      }
    }
  }
  if (char === "{") {
    cursor.index += 1;
    const table = {};
    skipInlineWhitespace(cursor);
    if (peek(cursor) === "}") {
      cursor.index += 1;
      return table;
    }
    for (;;) {
      const keyPath = readKey(cursor);
      if (peek(cursor) !== "=") {
        throw new Error("Expected = in inline table");
      }
      cursor.index += 1;
      assign(table, keyPath, readValue(cursor));
      skipInlineWhitespace(cursor);
      if (peek(cursor) === ",") {
        cursor.index += 1;
        skipInlineWhitespace(cursor);
        continue;
      }
      if (peek(cursor) === "}") {
        cursor.index += 1;
        return table;
      }
      throw new Error("Expected , or } in inline table");
    }
  }
  let token = "";
  while (cursor.index < cursor.text.length) {
    const current = peek(cursor);
    if (/[\s,\]}#]/.test(current)) {
      break;
    }
    token += current;
    cursor.index += 1;
  }
  if (token === "true") return true;
  if (token === "false") return false;
  const numeric = token.replace(/_/g, "");
  if (/^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(numeric)) {
    return Number(numeric);
  }
  if (/^0x[0-9A-Fa-f]+$/.test(numeric))
    return Number.parseInt(numeric.slice(2), 16);
  if (/^0o[0-7]+$/.test(numeric)) return Number.parseInt(numeric.slice(2), 8);
  if (/^0b[01]+$/.test(numeric)) return Number.parseInt(numeric.slice(2), 2);
  if (!token) {
    throw new Error("Expected value");
  }
  // Dates and other unsupported scalars are kept as raw text.
  return token;
};

const assign = (target, keyPath, value) => {
  let current = target;
  for (let index = 0; index < keyPath.length - 1; index += 1) {
    const key = keyPath[index];
    if (
      !current[key] ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key];
  }
  current[keyPath[keyPath.length - 1]] = value;
};

const resolveTable = (root, keyPath) => {
  let current = root;
  for (const key of keyPath) {
    if (
      !current[key] ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key];
  }
  return current;
};

const skipToNextLine = (cursor) => {
  while (cursor.index < cursor.text.length && peek(cursor) !== "\n") {
    cursor.index += 1;
  }
};

export const parseTomlLite = (text) => {
  const root = {};
  let table = root;
  const cursor = createCursor(String(text ?? "").replace(/^﻿/, ""));

  while (cursor.index < cursor.text.length) {
    skipWhitespaceAndComments(cursor);
    if (cursor.index >= cursor.text.length) {
      break;
    }
    const lineStart = cursor.index;
    try {
      if (peek(cursor) === "[") {
        const isArrayTable = peek(cursor, 1) === "[";
        cursor.index += isArrayTable ? 2 : 1;
        const keyPath = readKey(cursor);
        if (isArrayTable) {
          // Arrays of tables are not needed; skip the whole section.
          skipToNextLine(cursor);
          table = {};
          continue;
        }
        if (peek(cursor) !== "]") {
          throw new Error("Expected ] after table header");
        }
        cursor.index += 1;
        table = resolveTable(root, keyPath);
        skipToNextLine(cursor);
        continue;
      }
      const keyPath = readKey(cursor);
      if (peek(cursor) !== "=") {
        throw new Error("Expected = after key");
      }
      cursor.index += 1;
      const value = readValue(cursor);
      assign(table, keyPath, value);
      skipToNextLine(cursor);
    } catch {
      // Skip the offending line and keep going.
      cursor.index = Math.max(cursor.index, lineStart + 1);
      skipToNextLine(cursor);
    }
  }

  return root;
};
