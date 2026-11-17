/**
 * Chat submission: the one way a message is sent to a chat, whoever sends
 * it (the composer, a stash item, a saved prompt, review feedback). It
 * decides once whether the chat takes the message, recovers the `$skill`
 * mentions in its text, has the chat runtime start the turn, and answers
 * with a value: sent, refused with a reason, or failed with an error.
 *
 * The chat says why too: a refusal or failure is put on its banner (Chat turn
 * outcome), except a busy one, since the banner is the message's being sent.
 * Callers read the answer, never the banner.
 *
 * The composer's message is the chat's draft: it is emptied once sent and
 * left as it is otherwise. Every other sender lets go of its message when it
 * calls `sendChatMessage`, so a message from one that is not sent is added to
 * the chat's draft, whether or not a panel shows the chat.
 *
 * From the gate until the host has the message, the chat is in the store's
 * `sendingChatIds`: Chat activity counts it as not accepting a message, and
 * another send to it is refused. A turn running or streaming does not refuse
 * one; the host queues runs.
 *
 * The store cannot import this module (it reaches the store through the
 * chat runtime). Loading it registers `sendChatMessage` as the store's
 * submitter (store/chat-submitter.ts), which stash and saved-prompt actions
 * send through.
 */
import type { FileUIPart } from "ai";
import { projectScope } from "@/lib/project-resource-cache";
import type { ProjectReference } from "@/types/ide";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { useIdeStore } from "../ide-store";
import { PROVIDER_PRESENTATION } from "../provider-presentation";
import { isHostAway } from "../ssh/host-away";
import { setChatSubmitter } from "../store/chat-submitter";
import { chatDrafts } from "./chat-drafts";
import {
  getChatModelOptions,
  resolveChatModelSelection,
} from "./chat-model-selection";
import {
  chatT,
  dismissChatError,
  retainChatSession,
  startChatTurn,
} from "./chat-runtime";
import {
  hasPossibleSkillMention,
  type SerializedComposerDraft,
  serializeComposerDraft,
} from "./composer-draft";
import { fetchProviderSkills, providerSupportsSkills } from "./provider-skills";

/** A message for a chat. Its text is serialized (composer-draft.ts). */
export interface ChatSubmission {
  files?: FileUIPart[];
  references: ProjectReference[];
  /**
   * The `$skill` names the text mentions, when the sender already knows
   * them (the composer). Recovered from the text otherwise.
   */
  skills?: string[];
  text: string;
}

/** Who sends: only the composer's message is the chat's draft. */
export type ChatSubmissionOrigin =
  | "composer"
  | "feedback"
  | "saved-prompt"
  | "stash";

/** Why a chat did not take a message. */
export type ChatSendRefusal =
  /** The chat is gone, deleted, or not in the active project. */
  | "not-in-active-project"
  /** No text, references or files. */
  | "empty"
  /** A message to the chat is still being sent from this window. */
  | "busy"
  /** The chat's project is on an SSH host that is not there. */
  | "host-away"
  /** The chat's provider CLI is not installed. */
  | "provider-unavailable"
  /** No model is enabled for the chat. */
  | "no-model";

export type ChatSendResult =
  | { status: "sent" }
  | {
      status: "refused";
      reason: ChatSendRefusal;
      /** What the banner says; null for an empty message, which says nothing. */
      message: string | null;
    }
  | { status: "failed"; error: string };

export type SendChatMessage = (
  chatId: string,
  submission: ChatSubmission,
  options: { origin: ChatSubmissionOrigin },
) => Promise<ChatSendResult>;

type Refusal = Extract<ChatSendResult, { status: "refused" }>;

const refused = (reason: ChatSendRefusal, message: string | null): Refusal => ({
  status: "refused",
  reason,
  message,
});

/** The gate: why `chatId` cannot take `submission` now, or null. */
const refusalOf = (
  chatId: string,
  submission: ChatSubmission,
): Refusal | null => {
  const state = useIdeStore.getState();
  const chat = state.chats.find(
    (entry) => entry.id === chatId && entry.deletedAt === null,
  );
  const project = chat
    ? state.projects.find((entry) => entry.id === chat.projectId)
    : undefined;
  if (!chat || !project || state.activeProjectId !== project.id)
    return refused("not-in-active-project", chatT("notInActiveProject"));
  if (
    !submission.text.trim() &&
    submission.references.length === 0 &&
    !submission.files?.length
  )
    return refused("empty", null);
  if (state.sendingChatIds[chatId])
    return refused("busy", chatT("messageStillSending"));
  const away = isHostAway(state, project);
  if (away)
    return refused(
      "host-away",
      chatT("hostNotConnected", { host: away.label }),
    );
  const { selectedModel, selectedProvider } = resolveChatModelSelection(
    chat,
    getChatModelOptions(state.settings, state.providerModels),
  );
  if (!state.providerModels[selectedProvider]?.installed)
    return refused(
      "provider-unavailable",
      chatT("providerCliUnavailable", {
        provider: PROVIDER_PRESENTATION[selectedProvider].label,
      }),
    );
  if (!selectedModel) return refused("no-model", chatT("enableModelFirst"));
  return null;
};

/**
 * The submission's text serialized with the skills it mentions. Text from
 * anywhere but the composer is already serialized; serializing it again
 * recovers its skills, fetching the catalog only when the text could
 * mention one, as the composer does.
 */
const withSkills = async (
  chatId: string,
  submission: ChatSubmission,
): Promise<SerializedComposerDraft> => {
  const draft = { references: submission.references, text: submission.text };
  if (submission.skills) return { ...draft, skills: submission.skills };
  const state = useIdeStore.getState();
  const chat = state.chats.find((entry) => entry.id === chatId);
  const project = chat
    ? state.projects.find((entry) => entry.id === chat.projectId)
    : undefined;
  if (!chat || !project || !hasPossibleSkillMention(draft.text))
    return { ...draft, skills: [] };
  const { selectedProvider } = resolveChatModelSelection(
    chat,
    getChatModelOptions(state.settings, state.providerModels),
  );
  if (!providerSupportsSkills(selectedProvider))
    return { ...draft, skills: [] };
  const { skills } = await fetchProviderSkills(
    selectedProvider,
    projectScope(project),
  );
  return serializeComposerDraft(draft, skills);
};

/** A message the sender let go of and the chat did not take. */
const returnToDraft = (
  chatId: string,
  submission: ChatSubmission,
  origin: ChatSubmissionOrigin,
) => {
  if (origin === "composer" || !submission.text.trim()) return;
  if (!useIdeStore.getState().chats.some((chat) => chat.id === chatId)) return;
  chatDrafts.append(chatId, submission.text);
};

/**
 * Sends `submission` to `chatId`. The gate is decided before this returns
 * its promise, so a second call made at once is refused as busy. Resolves
 * once the host has the message (sent), or with why not.
 */
export const sendChatMessage: SendChatMessage = async (
  chatId,
  submission,
  { origin },
) => {
  const refusal = refusalOf(chatId, submission);
  if (refusal?.reason === "busy") {
    returnToDraft(chatId, submission, origin);
    return refusal;
  }
  dismissChatError(chatId);
  if (refusal) {
    if (refusal.message) chatTurnOutcomes.reportError(chatId, refusal.message);
    returnToDraft(chatId, submission, origin);
    return refusal;
  }

  const store = useIdeStore.getState();
  store.setChatSending(chatId, true);
  const projectId = store.chats.find((chat) => chat.id === chatId)?.projectId;
  if (projectId) store.setActiveChatId(projectId, chatId);
  let release = () => {};
  try {
    await useIdeStore.getState().loadRecentMessagesForChat(chatId);
    release = retainChatSession(chatId);
    const serialized = await withSkills(chatId, submission);
    await startChatTurn(chatId, {
      files: submission.files ?? [],
      ...serialized,
    });
    if (origin === "composer") chatDrafts.clear(chatId);
    return { status: "sent" };
  } catch (cause) {
    const error =
      cause instanceof Error && cause.message
        ? cause.message
        : chatT("unexpectedError");
    chatTurnOutcomes.reportError(chatId, error);
    returnToDraft(chatId, submission, origin);
    return { status: "failed", error };
  } finally {
    useIdeStore.getState().setChatSending(chatId, false);
    release();
  }
};

setChatSubmitter(sendChatMessage);
