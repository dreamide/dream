import type { ComponentProps, ComponentType } from "react";
import anthropicLogo from "@/assets/anthropic.svg";
import openAiLogo from "@/assets/openai.svg";
import openCodeLogo from "@/assets/opencode.svg";
import {
  AnthropicIcon,
  AntigravityIcon,
  CursorIcon,
  GrokIcon,
  OpenAiIcon,
  OpenCodeIcon,
} from "@/components/ai-elements/provider-icons";
import type { AiProvider } from "@/types/ide";

/**
 * How the renderer shows a Provider. What a Provider can do is its row in
 * electron/shared/provider-capabilities.js; this is only what it looks like.
 */
export type ProviderPresentation = {
  /** Its name in model pickers, the usage popover and its settings card. */
  label: string;
  /** Its agent CLI, under the name on its settings card and in Skills. */
  runtimeLabel: string;
  /** Its mark, drawn in `currentColor` unless the logo has its own colors. */
  Icon: ComponentType<ComponentProps<"svg">>;
  /**
   * The mark on its settings card: a logo image (inverted in dark), or
   * `Icon` with these classes.
   */
  cardMark: { logoSrc: string } | { iconClassName: string };
  /**
   * Its settings card lists models in tabs by the provider part of their
   * ids (OpenCode's `provider/model`).
   */
  groupsModels: boolean;
};

export const PROVIDER_PRESENTATION: Record<AiProvider, ProviderPresentation> = {
  openai: {
    label: "OpenAI",
    runtimeLabel: "Codex CLI",
    Icon: OpenAiIcon,
    cardMark: { logoSrc: openAiLogo },
    groupsModels: false,
  },
  anthropic: {
    label: "Anthropic",
    runtimeLabel: "Claude Code CLI",
    Icon: AnthropicIcon,
    cardMark: { logoSrc: anthropicLogo },
    groupsModels: false,
  },
  opencode: {
    label: "OpenCode",
    runtimeLabel: "OpenCode CLI",
    Icon: OpenCodeIcon,
    cardMark: { logoSrc: openCodeLogo },
    groupsModels: true,
  },
  cursor: {
    label: "Cursor",
    runtimeLabel: "Cursor Agent CLI",
    Icon: CursorIcon,
    cardMark: { iconClassName: "size-4 text-foreground" },
    groupsModels: false,
  },
  grok: {
    label: "Grok Build",
    runtimeLabel: "Grok Build CLI",
    Icon: GrokIcon,
    cardMark: { iconClassName: "size-4 text-foreground" },
    groupsModels: false,
  },
  antigravity: {
    label: "Antigravity",
    runtimeLabel: "Antigravity CLI",
    Icon: AntigravityIcon,
    // The logo keeps its own colors.
    cardMark: { iconClassName: "size-4" },
    groupsModels: false,
  },
};

export const ProviderIcon = ({
  provider,
  ...props
}: ComponentProps<"svg"> & { provider: AiProvider }) => {
  const { Icon } = PROVIDER_PRESENTATION[provider];
  return <Icon {...props} />;
};
