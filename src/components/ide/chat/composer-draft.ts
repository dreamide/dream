/**
 * The composer draft: the chat composer's text as a mention-aware document.
 *
 * The textarea holds plain text, and mentions are encoded in it. A file,
 * folder or picked skill takes the form of an icon slot (six spaces the
 * overlay draws an icon over) followed by its name: "      app.ts". A typed
 * skill is ordinary `$name` text. Mentions are read back from the text on
 * every render, not held beside it, so drafts survive remounts. Only the
 * picked files are held beside the text, because the name alone cannot
 * recover the path.
 *
 * The interface is small:
 * - `readComposerDraft(state, catalog)` scans the text once, giving the
 *   segments the overlay draws and the menu to show.
 * - `applyComposerEdit(state, edit, catalog)` covers typing, caret moves and
 *   picking from a menu.
 * - `handleComposerKey(state, key, catalog)` covers the keys the draft owns
 *   (menu navigation, atomic mention delete). It returns `null` for keys it
 *   leaves to the caller.
 * - `serializeComposerDraft(draft, skills)` gives what is sent:
 *   `{ text, references, skills }`, with `@path` and `$name` in the text.
 *
 * Everything here is pure, so each rule can be tested without a DOM.
 */
import type { ProjectReference, ProviderSkill } from "@/types/ide";

// ── Mention text ────────────────────────────────────────────────────────

/** Six spaces the overlay draws a mention's icon over. */
export const MENTION_ICON_SLOT = "      ";

const PROJECT_REFERENCE_RESULT_LIMIT = 8;
export const SKILL_RESULT_LIMIT = 50;

/**
 * `$name` mentions. Leaves currency amounts (`$50`, `$1.2k`) as prose: the
 * name must contain a letter and may not start with a digit. The server
 * (electron/api/chat/skill-dispatch.js) matches the same pattern.
 */
export const SKILL_MENTION_PATTERN =
  /(^|[\s([{])\$(?![0-9])([a-zA-Z0-9][a-zA-Z0-9:_-]*[a-zA-Z0-9]|[a-zA-Z])(?=$|[\s),.;:!?\]}])/g;

const charAt = (text: string, index: number) =>
  index >= 0 && index < text.length ? text[index] : undefined;

const isMentionBoundary = (character: string | undefined) =>
  !character || /\s|[),.;:!?]/.test(character);

/** A mention needs a boundary after it; its icon slot starts with a space. */
const isMentionAt = (text: string, start: number, length: number) =>
  (/\s/.test(charAt(text, start) ?? "") ||
    isMentionBoundary(charAt(text, start - 1))) &&
  isMentionBoundary(charAt(text, start + length));

const getReferenceMentionText = (reference: ProjectReference) =>
  `${MENTION_ICON_SLOT}${reference.name}`;

const hasReferenceMention = (text: string, reference: ProjectReference) => {
  const mention = getReferenceMentionText(reference);
  let index = text.indexOf(mention);
  while (index !== -1) {
    if (isMentionAt(text, index, mention.length)) {
      return true;
    }
    index = text.indexOf(mention, index + mention.length);
  }
  return false;
};

const isSameReference = (left: ProjectReference, right: ProjectReference) =>
  left.kind === right.kind && left.path === right.path;

// ── Skills ──────────────────────────────────────────────────────────────

/** What the menu shows: the provider's display name when it has one. */
export const getSkillLabel = (skill: ProviderSkill) =>
  skill.displayName?.trim() || skill.name;

export const isSkillOfferedInMenu = (skill: ProviderSkill) =>
  skill.enabled && skill.userInvocable !== false;

const isSameSkill = (left: ProviderSkill, right: ProviderSkill) =>
  left.source === right.source &&
  left.name === right.name &&
  left.path === right.path;

export type SkillMentionRange = {
  end: number;
  name: string;
  skill: ProviderSkill;
  start: number;
};

/** `$name` ranges in `text` whose name matches a known skill. */
export const findSkillMentions = (
  text: string,
  skills: ProviderSkill[],
): SkillMentionRange[] => {
  if (!text || skills.length === 0) {
    return [];
  }

  const byName = new Map(
    skills.map((skill) => [skill.name.toLowerCase(), skill] as const),
  );
  const ranges: SkillMentionRange[] = [];
  const pattern = new RegExp(SKILL_MENTION_PATTERN.source, "g");
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const name = match[2];
    const skill = byName.get(name.toLowerCase());
    if (skill) {
      const start = match.index + match[1].length;
      ranges.push({ end: start + name.length + 1, name, skill, start });
    }
    match = pattern.exec(text);
  }
  return ranges;
};

export const hasPossibleSkillMention = (text: string) =>
  new RegExp(SKILL_MENTION_PATTERN.source).test(text);

/**
 * The text each offered skill takes when picked: the icon slot plus its
 * label. Two skills sharing a label fall back to their unique names.
 */
const getPickedSkillMentionTexts = (skills: ProviderSkill[]) => {
  const offered = skills.filter(isSkillOfferedInMenu);
  const labelCounts = new Map<string, number>();
  for (const skill of offered) {
    const label = getSkillLabel(skill);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const byText = new Map<string, ProviderSkill>();
  for (const skill of offered) {
    const label = getSkillLabel(skill);
    const shown = (labelCounts.get(label) ?? 0) > 1 ? skill.name : label;
    const mentionText = `${MENTION_ICON_SLOT}${shown}`;
    if (!byText.has(mentionText)) {
      byText.set(mentionText, skill);
    }
  }
  return byText;
};

const getPickedSkillMentionText = (
  skill: ProviderSkill,
  mentionTexts: Map<string, ProviderSkill>,
) => {
  for (const [mentionText, candidate] of mentionTexts) {
    if (isSameSkill(candidate, skill)) {
      return mentionText;
    }
  }
  return `${MENTION_ICON_SLOT}${skill.name}`;
};

const getSkillScore = (skill: ProviderSkill, query: string) => {
  if (!query) {
    return 0;
  }

  const normalizedQuery = query.toLowerCase();
  const name = skill.name.toLowerCase();
  const displayName = (skill.displayName ?? "").toLowerCase();
  const description = (
    skill.shortDescription ??
    skill.description ??
    ""
  ).toLowerCase();

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(normalizedQuery)) {
    return 1;
  }
  if (displayName.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery) || displayName.includes(normalizedQuery)) {
    return 3;
  }
  if (description.includes(normalizedQuery)) {
    return 4;
  }
  return null;
};

export const searchProviderSkills = (
  skills: ProviderSkill[],
  query: string,
  limit = SKILL_RESULT_LIMIT,
) =>
  skills
    .filter(isSkillOfferedInMenu)
    .flatMap((skill) => {
      const score = getSkillScore(skill, query);
      return score === null ? [] : [{ score, skill }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        getSkillLabel(left.skill).localeCompare(getSkillLabel(right.skill)),
    )
    .slice(0, limit)
    .map(({ skill }) => skill);

// ── Project files ───────────────────────────────────────────────────────

const normalizeProjectPath = (path: string) => path.replace(/\\/g, "/");

const getReferenceName = (path: string) => {
  const normalized = normalizeProjectPath(path);
  return normalized.split("/").pop() || normalized;
};

const getReferenceParentPath = (path: string) => {
  const normalized = normalizeProjectPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
};

/**
 * What the `@` menu can offer for a project's file list: every file plus
 * every folder above one, folders first.
 */
export const buildProjectReferenceIndex = (
  files: string[],
): ProjectReference[] => {
  const folders = new Set<string>();
  const normalizedFiles = files.map(normalizeProjectPath);

  for (const filePath of normalizedFiles) {
    const segments = filePath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"));
    }
  }

  return [
    ...[...folders].map((path) => ({
      kind: "folder" as const,
      name: getReferenceName(path),
      parentPath: getReferenceParentPath(path),
      path,
    })),
    ...normalizedFiles.map((path) => ({
      kind: "file" as const,
      name: getReferenceName(path),
      parentPath: getReferenceParentPath(path),
      path,
    })),
  ].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });
};

const getReferenceScore = (item: ProjectReference, query: string) => {
  if (!query) {
    return item.kind === "folder" ? 1 : 2;
  }

  const normalizedQuery = query.toLowerCase();
  const name = item.name.toLowerCase();
  const path = item.path.toLowerCase();

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(normalizedQuery)) {
    return 1;
  }
  if (path.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery)) {
    return 3;
  }
  if (path.includes(normalizedQuery)) {
    return 4;
  }
  return null;
};

export const searchProjectReferences = (
  items: ProjectReference[],
  query: string,
) =>
  items
    .flatMap((item) => {
      const score = getReferenceScore(item, query);
      return score === null ? [] : [{ item, score }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.item.path.localeCompare(right.item.path),
    )
    .slice(0, PROJECT_REFERENCE_RESULT_LIMIT)
    .map(({ item }) => item);

// ── Tokens at the caret ─────────────────────────────────────────────────

export type MentionToken = {
  end: number;
  query: string;
  start: number;
};

/** The `@query` token the caret is inside, if any. */
export const getActiveReferenceToken = (
  text: string,
  caretIndex: number,
): MentionToken | null => {
  const beforeCaret = text.slice(0, caretIndex);
  const atIndex = beforeCaret.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }

  const characterBefore = atIndex > 0 ? beforeCaret.at(atIndex - 1) : "";
  if (characterBefore && !/\s|[([{]/.test(characterBefore)) {
    return null;
  }

  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) {
    return null;
  }

  return { end: caretIndex, query, start: atIndex };
};

/**
 * The `$query` token the caret is inside, if any. Mirrors the `@` rule: the
 * `$` must start the text or follow whitespace or a bracket.
 */
export const getActiveSkillToken = (
  text: string,
  caretIndex: number,
): MentionToken | null => {
  const beforeCaret = text.slice(0, caretIndex);
  const dollarIndex = beforeCaret.lastIndexOf("$");
  if (dollarIndex === -1) {
    return null;
  }

  const characterBefore =
    dollarIndex > 0 ? beforeCaret.at(dollarIndex - 1) : "";
  if (characterBefore && !/\s|[([{]/.test(characterBefore)) {
    return null;
  }

  const query = beforeCaret.slice(dollarIndex + 1);
  if (/\s/.test(query) || /^[0-9]/.test(query)) {
    return null;
  }
  if (!/^[a-zA-Z0-9:_-]*$/.test(query)) {
    return null;
  }

  return { end: caretIndex, query, start: dollarIndex };
};

// ── The draft ───────────────────────────────────────────────────────────

/** What is sent, or queued to be sent: the text plus the picked files. */
export interface ComposerDraft {
  references: ProjectReference[];
  text: string;
}

export type ComposerToken = {
  highlighted: number;
  kind: "reference" | "skill";
  token: MentionToken;
};

/** The draft while it is being edited: plus the token at the caret. */
export interface ComposerState extends ComposerDraft {
  token: ComposerToken | null;
}

/** What the draft is read against. */
export interface ComposerCatalog {
  /** The project's files and folders, from `buildProjectReferenceIndex`. */
  projectReferences: ProjectReference[];
  /** The provider's skills; empty until discovery has run. */
  skills: ProviderSkill[];
  /** Whether the provider loads skills at all. */
  skillsSupported: boolean;
}

export const EMPTY_COMPOSER_STATE: ComposerState = {
  references: [],
  text: "",
  token: null,
};

export type ComposerSegment =
  | { end: number; kind: "text"; start: number; text: string }
  | {
      end: number;
      kind: "reference";
      reference: ProjectReference;
      start: number;
    }
  | {
      end: number;
      kind: "picked-skill";
      /** The name shown after the icon slot. */
      label: string;
      skill: ProviderSkill;
      start: number;
    }
  | {
      end: number;
      kind: "typed-skill";
      skill: ProviderSkill;
      start: number;
      text: string;
    };

export type ComposerMenu =
  | { highlighted: number; items: ProjectReference[]; kind: "reference" }
  | { highlighted: number; items: ProviderSkill[]; kind: "skill" };

export interface ComposerView {
  /** The whole text, in order, split into prose and mentions. */
  segments: ComposerSegment[];
  /** Whether any mention needs the overlay drawn over the textarea. */
  hasMentions: boolean;
  /** The menu to show under the caret, if any. */
  menu: ComposerMenu | null;
}

type Range = { end: number; start: number };

const overlaps = (left: Range, right: Range) =>
  left.start < right.end && left.end > right.start;

const findReferenceRanges = (text: string, references: ProjectReference[]) =>
  references.flatMap((reference) => {
    const mention = getReferenceMentionText(reference);
    const ranges: (Range & { reference: ProjectReference })[] = [];
    let index = text.indexOf(mention);
    while (index !== -1) {
      if (isMentionAt(text, index, mention.length)) {
        ranges.push({ end: index + mention.length, reference, start: index });
      }
      index = text.indexOf(mention, index + mention.length);
    }
    return ranges;
  });

const findPickedSkillRanges = (
  text: string,
  mentionTexts: Map<string, ProviderSkill>,
  taken: Range[],
) => {
  const ranges: (Range & { skill: ProviderSkill })[] = [];
  if (mentionTexts.size === 0 || !text.includes(MENTION_ICON_SLOT)) {
    return ranges;
  }
  // Longest first, so "PDF Tools" wins over "PDF".
  const candidates = [...mentionTexts.keys()].sort(
    (left, right) => right.length - left.length,
  );
  for (const mentionText of candidates) {
    const skill = mentionTexts.get(mentionText);
    if (!skill) {
      continue;
    }
    let index = text.indexOf(mentionText);
    while (index !== -1) {
      const range = { end: index + mentionText.length, start: index };
      if (
        isMentionAt(text, index, mentionText.length) &&
        ![...taken, ...ranges].some((other) => overlaps(range, other))
      ) {
        ranges.push({ ...range, skill });
      }
      index = text.indexOf(mentionText, index + 1);
    }
  }
  return ranges;
};

/**
 * The one scan of the encoding. Files claim their text first; picked skills
 * take icon slots no file claimed; typed `$name` skills are found by pattern.
 * The text is then walked in order so no two mentions share a character.
 */
const segmentDraft = (
  draft: ComposerDraft,
  skills: ProviderSkill[],
  skillsSupported: boolean,
): ComposerSegment[] => {
  const { text } = draft;
  if (!text) {
    return [];
  }

  const referenceRanges = findReferenceRanges(text, draft.references);
  const mentions: ComposerSegment[] = [
    ...referenceRanges.map(
      (range): ComposerSegment => ({ ...range, kind: "reference" }),
    ),
  ];
  if (skillsSupported) {
    for (const range of findPickedSkillRanges(
      text,
      getPickedSkillMentionTexts(skills),
      referenceRanges,
    )) {
      mentions.push({
        ...range,
        kind: "picked-skill",
        label: text.slice(range.start + MENTION_ICON_SLOT.length, range.end),
      });
    }
    for (const range of findSkillMentions(text, skills)) {
      mentions.push({
        end: range.end,
        kind: "typed-skill",
        skill: range.skill,
        start: range.start,
        text: text.slice(range.start, range.end),
      });
    }
  }

  // Earliest first; at the same start the longer mention wins.
  mentions.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );

  const segments: ComposerSegment[] = [];
  let index = 0;
  for (const mention of mentions) {
    if (mention.start < index) {
      continue;
    }
    if (mention.start > index) {
      segments.push({
        end: mention.start,
        kind: "text",
        start: index,
        text: text.slice(index, mention.start),
      });
    }
    segments.push(mention);
    index = mention.end;
  }
  if (index < text.length) {
    segments.push({
      end: text.length,
      kind: "text",
      start: index,
      text: text.slice(index),
    });
  }
  return segments;
};

/** Mentions that delete as one unit: files and picked skills. */
const isAtomicSegment = (segment: ComposerSegment) =>
  segment.kind === "reference" || segment.kind === "picked-skill";

const getMenu = (
  state: ComposerState,
  catalog: ComposerCatalog,
): ComposerMenu | null => {
  const { token } = state;
  if (!token || state.text === "") {
    return null;
  }

  if (token.kind === "reference") {
    // The token is a file already picked: nothing left to offer.
    if (
      state.references.some((reference) => reference.name === token.token.query)
    ) {
      return null;
    }
    const items = searchProjectReferences(
      catalog.projectReferences,
      token.token.query,
    );
    return items.length > 0
      ? {
          highlighted: Math.min(token.highlighted, items.length - 1),
          items,
          kind: "reference",
        }
      : null;
  }

  const items = searchProviderSkills(catalog.skills, token.token.query);
  return items.length > 0
    ? {
        highlighted: Math.min(token.highlighted, items.length - 1),
        items,
        kind: "skill",
      }
    : null;
};

export const readComposerDraft = (
  state: ComposerState,
  catalog: ComposerCatalog,
): ComposerView => {
  const segments = segmentDraft(state, catalog.skills, catalog.skillsSupported);
  return {
    hasMentions: segments.some((segment) => segment.kind !== "text"),
    menu: getMenu(state, catalog),
    segments,
  };
};

/**
 * Whether the provider's skill catalog is needed to read this draft: the
 * caret is on a `$` token, the text has a possible `$name`, or an icon slot
 * no file claims (probably a picked skill). Discovery can start a provider
 * process (Codex), so it is only asked for when one of these holds.
 */
export const composerNeedsSkillCatalog = (
  state: ComposerState,
  skillsSupported: boolean,
) => {
  if (!skillsSupported) {
    return false;
  }
  if (state.token?.kind === "skill" || hasPossibleSkillMention(state.text)) {
    return true;
  }
  if (!state.text.includes(MENTION_ICON_SLOT)) {
    return false;
  }
  const taken = findReferenceRanges(state.text, state.references);
  let index = state.text.indexOf(MENTION_ICON_SLOT);
  while (index !== -1) {
    const at = index;
    if (!taken.some((range) => at >= range.start && at < range.end)) {
      return true;
    }
    index = state.text.indexOf(MENTION_ICON_SLOT, index + 1);
  }
  return false;
};

// ── Edits ───────────────────────────────────────────────────────────────

export type ComposerEdit =
  /** The textarea's value changed (typing, paste, cut, undo). */
  | { caret: number | null; text: string; type: "input" }
  /** The caret moved without the text changing. */
  | { caret: number | null; type: "caret" }
  | { reference: ProjectReference; type: "pick-reference" }
  | { skill: ProviderSkill; type: "pick-skill" }
  | { index: number; type: "highlight" }
  /** Escape: close the menu, keep the text. */
  | { type: "dismiss" }
  /** The draft was sent; the text is cleared by the caller. */
  | { type: "submitted" };

export interface ComposerEditResult {
  /** Where the caret goes, when the edit moved it. */
  caret?: number;
  state: ComposerState;
}

const tokenAt = (
  text: string,
  caret: number | null,
  skillsSupported: boolean,
): ComposerToken | null => {
  if (caret === null) {
    return null;
  }
  const reference = getActiveReferenceToken(text, caret);
  if (reference) {
    return { highlighted: 0, kind: "reference", token: reference };
  }
  const skill = skillsSupported ? getActiveSkillToken(text, caret) : null;
  return skill ? { highlighted: 0, kind: "skill", token: skill } : null;
};

/** Replaces the token at the caret with a mention and a separator. */
const insertMention = (
  state: ComposerState,
  token: MentionToken,
  mentionText: string,
) => {
  const before = state.text.slice(0, token.start);
  const after = state.text.slice(token.end);
  const next = after.at(0);
  const separator = next !== undefined && isMentionBoundary(next) ? "" : " ";
  return {
    caret: before.length + mentionText.length + separator.length,
    text: `${before}${mentionText}${separator}${after}`,
  };
};

const keepMentionedReferences = (
  text: string,
  references: ProjectReference[],
) => references.filter((reference) => hasReferenceMention(text, reference));

export const applyComposerEdit = (
  state: ComposerState,
  edit: ComposerEdit,
  catalog: ComposerCatalog,
): ComposerEditResult => {
  switch (edit.type) {
    case "input":
      return {
        state: {
          references: keepMentionedReferences(edit.text, state.references),
          text: edit.text,
          token: tokenAt(edit.text, edit.caret, catalog.skillsSupported),
        },
      };
    case "caret":
      return {
        state: {
          ...state,
          token: tokenAt(state.text, edit.caret, catalog.skillsSupported),
        },
      };
    case "pick-reference": {
      if (state.token?.kind !== "reference") {
        return { state };
      }
      const { caret, text } = insertMention(
        state,
        state.token.token,
        getReferenceMentionText(edit.reference),
      );
      return {
        caret,
        state: {
          references: state.references.some((reference) =>
            isSameReference(reference, edit.reference),
          )
            ? state.references
            : [...state.references, edit.reference],
          text,
          token: null,
        },
      };
    }
    case "pick-skill": {
      if (state.token?.kind !== "skill") {
        return { state };
      }
      const { caret, text } = insertMention(
        state,
        state.token.token,
        getPickedSkillMentionText(
          edit.skill,
          getPickedSkillMentionTexts(catalog.skills),
        ),
      );
      return { caret, state: { ...state, text, token: null } };
    }
    case "highlight":
      return {
        state: state.token
          ? { ...state, token: { ...state.token, highlighted: edit.index } }
          : state,
      };
    case "dismiss":
      return { state: { ...state, token: null } };
    case "submitted":
      return { state: { ...state, references: [], token: null } };
  }
};

// ── Keys ────────────────────────────────────────────────────────────────

export interface ComposerKey {
  key: string;
  selectionEnd: number;
  selectionStart: number;
}

/**
 * The text range a Backspace or Delete removes when it touches an atomic
 * mention: the whole mention, widened to cover a selection across several.
 */
const getMentionDeletionRange = (
  key: "Backspace" | "Delete",
  ranges: Range[],
  selectionStart: number,
  selectionEnd: number,
): Range | null => {
  if (selectionStart !== selectionEnd) {
    const hit = ranges.filter((range) =>
      overlaps(range, { end: selectionEnd, start: selectionStart }),
    );
    if (hit.length === 0) {
      return null;
    }
    return {
      end: Math.max(selectionEnd, ...hit.map((range) => range.end)),
      start: Math.min(selectionStart, ...hit.map((range) => range.start)),
    };
  }

  return (
    ranges.find((range) =>
      key === "Backspace"
        ? selectionStart > range.start && selectionStart <= range.end
        : selectionStart >= range.start && selectionStart < range.end,
    ) ?? null
  );
};

/** Removes a mention and one of the spaces around it, so none doubles up. */
const removeRange = (text: string, range: Range) => {
  let { end, start } = range;
  if (charAt(text, start - 1) === " " && charAt(text, end) === " ") {
    end += 1;
  } else if (start === 0 && charAt(text, end) === " ") {
    end += 1;
  } else if (
    charAt(text, start - 1) === " " &&
    (end === text.length || isMentionBoundary(charAt(text, end)))
  ) {
    start -= 1;
  }
  return { caret: start, text: `${text.slice(0, start)}${text.slice(end)}` };
};

/**
 * Handles a key the draft owns. `null` means the key is not the draft's and
 * the caller handles it (Enter to send, history, and so on); otherwise the
 * caller prevents the default and applies the result.
 */
export const handleComposerKey = (
  state: ComposerState,
  { key, selectionEnd, selectionStart }: ComposerKey,
  catalog: ComposerCatalog,
): ComposerEditResult | null => {
  if (key === "PageUp" || key === "PageDown") {
    // Chromium can route these keys to the horizontally scrollable chat
    // stack and move the entire active chat out of the viewport.
    return { state };
  }

  const view = readComposerDraft(state, catalog);

  if (key === "Backspace" || key === "Delete") {
    const range = getMentionDeletionRange(
      key,
      view.segments.filter(isAtomicSegment),
      selectionStart,
      selectionEnd,
    );
    if (range) {
      const { caret, text } = removeRange(state.text, range);
      return {
        caret,
        state: {
          references: keepMentionedReferences(text, state.references),
          text,
          token: null,
        },
      };
    }
  }

  const { menu } = view;
  if (menu && state.token) {
    const count = menu.items.length;
    if (key === "ArrowDown" || key === "ArrowUp") {
      const step = key === "ArrowDown" ? 1 : -1;
      return applyComposerEdit(
        state,
        { index: (menu.highlighted + step + count) % count, type: "highlight" },
        catalog,
      );
    }
    if (key === "Enter" || key === "Tab") {
      if (menu.kind === "reference") {
        const reference = menu.items[menu.highlighted];
        return reference
          ? applyComposerEdit(
              state,
              { reference, type: "pick-reference" },
              catalog,
            )
          : { state };
      }
      const skill = menu.items[menu.highlighted];
      return skill
        ? applyComposerEdit(state, { skill, type: "pick-skill" }, catalog)
        : { state };
    }
  }

  if (state.token && key === "Escape") {
    return applyComposerEdit(state, { type: "dismiss" }, catalog);
  }

  return null;
};

// ── Sending ─────────────────────────────────────────────────────────────

export interface SerializedComposerDraft extends ComposerDraft {
  /** Unique names of the skills the text mentions, picked or typed. */
  skills: string[];
}

/**
 * What is sent: files become `@path` and picked skills `$name` (what the
 * providers look for), padded with a space only where they would touch a
 * word. Text already serialized passes through unchanged, so a queued
 * prompt can be serialized again to recover its skills.
 */
export const serializeComposerDraft = (
  draft: ComposerDraft,
  skills: ProviderSkill[],
  { skillsSupported = true }: { skillsSupported?: boolean } = {},
): SerializedComposerDraft => {
  const segments = segmentDraft(draft, skills, skillsSupported);
  let text = "";
  const skillNames = new Set<string>();

  for (const segment of segments) {
    if (segment.kind === "text") {
      text += segment.text;
      continue;
    }
    if (segment.kind === "typed-skill") {
      text += segment.text;
      skillNames.add(segment.skill.name);
      continue;
    }
    const previous = text.at(-1);
    // `@path` and `$name` are matched after whitespace or an opening bracket.
    const pad = previous && !/[\s([{]/.test(previous) ? " " : "";
    if (segment.kind === "reference") {
      text += `${pad}@${segment.reference.path}`;
    } else {
      text += `${pad}$${segment.skill.name}`;
      skillNames.add(segment.skill.name);
    }
  }

  return {
    references: draft.references,
    skills: [...skillNames],
    text: segments.length > 0 ? text : draft.text,
  };
};
