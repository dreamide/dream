/**
 * Send-time handling of `$skill` mentions.
 *
 * The composer stores the literal `$name` in the message. Just before a turn
 * starts, the latest user message is checked against the provider's skill
 * catalog and the mention is turned into whatever that provider expands
 * natively. SKILL.md content is never pasted into the prompt: the agent
 * loads it itself, which keeps progressive disclosure, `allowed-tools` and
 * script-relative paths intact.
 *
 * - Codex parses `$name` in user text itself, so the message is unchanged.
 * - Claude runs through an AI SDK provider that prefixes every user turn
 *   with `Human:`, so a leading `/name` never reaches the CLI's slash
 *   parser. Instead the message ends with an instruction to invoke the
 *   skill through the Skill tool (enabled by `skills: "all"`). Skills with
 *   `disable-model-invocation` cannot be loaded by that tool, so the model
 *   is pointed at the SKILL.md path to read instead.
 * - OpenCode loads skills through its `skill` tool the same way.
 * - Cursor expands `/name` at the start of a prompt; the ACP prompt is
 *   prefixed with it.
 */

import { listProviderSkills } from "../skills/index.js";
import { getLatestUserMessage } from "./codex-prompt.js";

export const SKILL_MENTION_PATTERN =
  /(^|[\s([{])\$(?![0-9])([a-zA-Z0-9][a-zA-Z0-9:_-]*[a-zA-Z0-9]|[a-zA-Z])(?=$|[\s),.;:!?\]}])/g;

export const findSkillMentions = (text, skills) => {
  if (!text || !Array.isArray(skills) || skills.length === 0) {
    return [];
  }

  const byName = new Map(
    skills.map((skill) => [String(skill.name).toLowerCase(), skill]),
  );
  const pattern = new RegExp(SKILL_MENTION_PATTERN.source, "g");
  const mentions = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[2];
    const skill = byName.get(name.toLowerCase());
    if (skill && skill.enabled !== false) {
      const start = match.index + match[1].length;
      mentions.push({ end: start + name.length + 1, name, skill, start });
    }
    match = pattern.exec(text);
  }
  return mentions;
};

export const getMessageText = (message) => {
  if (!message || !Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
};

const uniqueSkills = (mentions) => {
  const seen = new Set();
  const skills = [];
  for (const mention of mentions) {
    const key = mention.skill.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      skills.push(mention.skill);
    }
  }
  return skills;
};

const describeSkill = (skill) =>
  skill.description ? ` (${skill.description})` : "";

export const buildClaudeSkillInstruction = (skills) => {
  const lines = ["Skills the user asked for in this message:"];
  for (const skill of skills) {
    if (skill.userInvocationOnly && skill.path) {
      lines.push(
        `- "${skill.name}"${describeSkill(skill)}: this skill only runs on user request, so read its instructions at ${skill.path} with the Read tool and follow them for this request.`,
      );
    } else {
      lines.push(
        `- "${skill.name}"${describeSkill(skill)}: invoke it with the Skill tool before doing anything else, then follow its instructions for this request.`,
      );
    }
  }
  return lines.join("\n");
};

export const buildOpenCodeSkillInstruction = (skills) => {
  const lines = ["Skills the user asked for in this message:"];
  for (const skill of skills) {
    lines.push(
      `- "${skill.name}"${describeSkill(skill)}: load it with the skill tool before doing anything else, then follow its instructions for this request.`,
    );
  }
  return lines.join("\n");
};

/**
 * Works out what to do with the mentions in `text` for `provider`.
 *
 * @returns {null | {
 *   skills: object[],
 *   instruction?: string,
 *   slashCommand?: string,
 * }}
 */
export const planSkillDispatch = ({ provider, skills, text }) => {
  const mentions = findSkillMentions(text, skills);
  if (mentions.length === 0) {
    return null;
  }
  const invoked = uniqueSkills(mentions);

  switch (provider) {
    case "anthropic":
      return {
        instruction: buildClaudeSkillInstruction(invoked),
        skills: invoked,
      };
    case "opencode":
      return {
        instruction: buildOpenCodeSkillInstruction(invoked),
        skills: invoked,
      };
    case "cursor": {
      // Cursor expands one slash command per prompt; the last mention wins,
      // matching what a user typing `/name` in its composer would get.
      const last = mentions[mentions.length - 1];
      return { skills: invoked, slashCommand: last.skill.name };
    }
    case "openai":
      return { skills: invoked };
    default:
      return null;
  }
};

/**
 * Appends the dispatch instruction to the latest user message as an extra
 * text part, leaving the user's own text intact.
 */
export const applySkillDispatchToMessages = (messages, plan) => {
  if (!plan?.instruction || !Array.isArray(messages)) {
    return messages;
  }
  const latestUserMessage = getLatestUserMessage(messages);
  if (!latestUserMessage) {
    return messages;
  }
  return messages.map((message) =>
    message === latestUserMessage
      ? {
          ...message,
          parts: [
            ...(Array.isArray(message.parts) ? message.parts : []),
            { text: plan.instruction, type: "text" },
          ],
        }
      : message,
  );
};

export const applySkillSlashPrefix = (prompt, slashCommand) => {
  if (!slashCommand) {
    return prompt;
  }
  return `/${slashCommand} ${prompt}`;
};

/**
 * Looks up the provider's skills (cached) and plans the dispatch for the
 * latest user message. Never throws: a discovery failure just means the
 * mention is sent as plain text.
 */
export const resolveSkillDispatch = async ({
  mcpServers = [],
  messages,
  projectPath,
  provider,
}) => {
  const text = getMessageText(getLatestUserMessage(messages));
  if (!text || !new RegExp(SKILL_MENTION_PATTERN.source).test(text)) {
    return null;
  }

  try {
    const { skills } = await listProviderSkills({
      mcpServers,
      projectPath,
      provider,
    });
    return planSkillDispatch({ provider, skills, text });
  } catch (error) {
    console.warn(
      "[skills] Skill lookup failed; sending the mention as plain text.",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
