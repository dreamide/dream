/**
 * Minimal YAML front matter reader for SKILL.md and command files.
 *
 * Skill front matter is a flat map of scalars plus an optional one-level
 * `metadata` map. Block scalars (`>` / `|`) are common in descriptions, so
 * they are supported; anything more exotic falls back to a raw string.
 */

const FRONT_MATTER_PATTERN =
  /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (value) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      return first === '"'
        ? inner.replace(/\\(["\\nt])/g, (_, char) =>
            char === "n" ? "\n" : char === "t" ? "\t" : char,
          )
        : inner.replace(/''/g, "'");
    }
  }
  // Strip trailing comments on unquoted scalars.
  return trimmed.replace(/\s+#.*$/, "");
};

const parseScalar = (raw) => {
  const value = unquote(raw);
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "false" || lower === "no" || lower === "off") {
    return false;
  }
  if (lower === "null" || lower === "~" || value === "") {
    return null;
  }
  return value;
};

const indentOf = (line) => line.length - line.trimStart().length;

const readBlockScalar = (lines, startIndex, indicator) => {
  const folded = indicator.startsWith(">");
  const collected = [];
  let index = startIndex;
  let blockIndent = null;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push("");
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    if (blockIndent === null) {
      if (indent === 0) {
        break;
      }
      blockIndent = indent;
    }
    if (indent < blockIndent) {
      break;
    }
    collected.push(line.slice(blockIndent));
    index += 1;
  }

  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }

  let text;
  if (folded) {
    const paragraphs = [];
    let paragraph = [];
    for (const line of collected) {
      if (line === "") {
        paragraphs.push(paragraph.join(" "));
        paragraph = [];
      } else {
        paragraph.push(line);
      }
    }
    paragraphs.push(paragraph.join(" "));
    text = paragraphs.join("\n");
  } else {
    text = collected.join("\n");
  }

  return { nextIndex: index, value: text };
};

const readNestedMap = (lines, startIndex) => {
  const map = {};
  let index = startIndex;
  let mapIndent = null;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    if (mapIndent === null) {
      if (indent === 0) {
        break;
      }
      mapIndent = indent;
    }
    if (indent < mapIndent) {
      break;
    }
    const match = line.trim().match(/^([^:#][^:]*?)\s*:\s*(.*)$/);
    if (match) {
      map[match[1].trim()] = parseScalar(match[2]);
    }
    index += 1;
  }

  return { nextIndex: index, value: map };
};

const readSequence = (lines, startIndex) => {
  const items = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const match = line.match(/^\s+-\s*(.*)$/);
    if (!match) {
      break;
    }
    items.push(parseScalar(match[1]));
    index += 1;
  }
  return { nextIndex: index, value: items };
};

/**
 * Parses the leading YAML front matter block.
 *
 * @returns {{ attributes: Record<string, unknown>, body: string }}
 */
export const parseFrontMatter = (text) => {
  const source = String(text ?? "");
  const match = source.match(FRONT_MATTER_PATTERN);
  if (!match) {
    return { attributes: {}, body: source };
  }

  const attributes = {};
  const lines = match[1].split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (
      line.trim() === "" ||
      line.trim().startsWith("#") ||
      indentOf(line) > 0
    ) {
      index += 1;
      continue;
    }
    const keyMatch = line.match(/^([^:#][^:]*?)\s*:\s*(.*)$/);
    if (!keyMatch) {
      index += 1;
      continue;
    }
    const key = keyMatch[1].trim();
    const rawValue = keyMatch[2].trim();

    if (/^[>|][+-]?$/.test(rawValue)) {
      const block = readBlockScalar(lines, index + 1, rawValue);
      attributes[key] = block.value;
      index = block.nextIndex;
      continue;
    }

    if (rawValue === "" || rawValue.startsWith("#")) {
      const next = lines[index + 1] ?? "";
      if (/^\s+-\s/.test(next)) {
        const sequence = readSequence(lines, index + 1);
        attributes[key] = sequence.value;
        index = sequence.nextIndex;
        continue;
      }
      if (indentOf(next) > 0 && next.trim() !== "") {
        const nested = readNestedMap(lines, index + 1);
        attributes[key] = nested.value;
        index = nested.nextIndex;
        continue;
      }
      attributes[key] = null;
      index += 1;
      continue;
    }

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      attributes[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item))
        .filter((item) => item.length > 0);
      index += 1;
      continue;
    }

    attributes[key] = parseScalar(rawValue);
    index += 1;
  }

  return { attributes, body: source.slice(match[0].length) };
};

/**
 * First meaningful line of a markdown body, used as a description fallback
 * for command files that carry no front matter.
 */
export const summarizeMarkdownBody = (body, maxLength = 200) => {
  for (const rawLine of String(body ?? "").split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    if (
      line.length > 0 &&
      !line.startsWith("<!--") &&
      !line.startsWith("```")
    ) {
      return line.length > maxLength
        ? `${line.slice(0, maxLength - 1)}…`
        : line;
    }
  }
  return "";
};
