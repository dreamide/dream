import type { ChatStatus } from "ai";
import { Shield } from "lucide-react";
import type { KeyboardEventHandler } from "react";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Sparkles from "@/components/ui/sparkles";
import type { AiProvider, ReasoningEffort } from "@/types/ide";
import { BranchSwitcher } from "../branch-switcher";
import { PromptAttachments } from "../chat";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  type ClaudePermissionMode,
  CODEX_PERMISSION_MODE_OPTIONS,
  type CodexPermissionMode,
  getClaudePermissionModeLabel,
  getCodexPermissionModeLabel,
} from "../ide-types";
import { UsageLimitsPopover } from "./usage-limits-popover";

export interface ChatPanelModelOption {
  id: string;
  label: string;
  provider: AiProvider;
  reasoningEfforts: ReasoningEffort[];
}

export interface ChatPanelReasoningOption {
  label: string;
  value: ReasoningEffort;
}

export interface ChatComposerProps {
  allModelOptions: ChatPanelModelOption[];
  chatProvider: AiProvider;
  claudePermissionMode: ClaudePermissionMode;
  codexPermissionMode: CodexPermissionMode;
  contextWindow: number;
  estimatedUsedTokens: number;
  isProcessing: boolean;
  isProviderInstalled: boolean;
  modelId: string;
  onClaudePermissionModeChange: (mode: ClaudePermissionMode) => void;
  onCodexPermissionModeChange: (mode: CodexPermissionMode) => void;
  onModelChange: (option: ChatPanelModelOption) => void;
  onPromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onPromptTextChange: (value: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onStop: () => void;
  onSubmit: (prompt: PromptInputMessage) => void | Promise<void>;
  promptDomId: string;
  promptInputDomId: string;
  promptText: string;
  projectId: string;
  projectPath: string;
  reasoningEffortOptions: ChatPanelReasoningOption[];
  selectedModel: string;
  selectedModelLabel: string;
  selectedModelValue: string | undefined;
  selectedProvider: AiProvider;
  selectedReasoningEffort: ReasoningEffort;
  selectedReasoningLabel: string;
  status: ChatStatus;
}

export const ChatComposer = ({
  allModelOptions,
  chatProvider,
  claudePermissionMode,
  codexPermissionMode,
  contextWindow,
  estimatedUsedTokens,
  isProcessing,
  isProviderInstalled,
  modelId,
  onClaudePermissionModeChange,
  onCodexPermissionModeChange,
  onModelChange,
  onPromptKeyDown,
  onPromptTextChange,
  onReasoningEffortChange,
  onStop,
  onSubmit,
  promptDomId,
  promptInputDomId,
  promptText,
  projectId,
  projectPath,
  reasoningEffortOptions,
  selectedModel,
  selectedModelLabel,
  selectedModelValue,
  selectedProvider,
  selectedReasoningEffort,
  selectedReasoningLabel,
  status,
}: ChatComposerProps) => (
  <div id={promptDomId} className="shrink-0 px-2 pb-2">
    <div className="mx-auto w-full max-w-[700px]">
      <Sparkles
        density={70}
        disabled={!isProcessing}
        height={30}
        sway={0}
        speed={2}
        palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
      >
        <div className="overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
          <PromptInput
            id={promptInputDomId}
            className="w-full [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
            onSubmit={onSubmit}
          >
            <PromptInputBody>
              <PromptAttachments />
              <PromptInputTextarea
                className="min-h-0 border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                onChange={(event) => onPromptTextChange(event.target.value)}
                onKeyDown={onPromptKeyDown}
                placeholder="Ask anything..."
                rows={1}
                value={promptText}
              />
            </PromptInputBody>
            <PromptInputFooter className="items-center">
              <PromptInputTools>
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger tooltip="Attach file" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
              </PromptInputTools>
              <div className="ml-auto flex items-center gap-2">
                <PromptInputSubmit
                  className="size-8 rounded-md"
                  disabled={
                    !isProcessing &&
                    (!isProviderInstalled ||
                      selectedModel === "" ||
                      promptText.trim() === "")
                  }
                  onStop={onStop}
                  status={status}
                />
              </div>
            </PromptInputFooter>
          </PromptInput>

          <div className="flex items-center gap-1 border-t border-foreground/10 px-2 py-1.5">
            <Select
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                const matchingOptions = allModelOptions.filter(
                  (option) => option.id === value,
                );
                const nextOption =
                  matchingOptions.find(
                    (option) => option.provider === chatProvider,
                  ) ?? matchingOptions[0];
                if (!nextOption) return;

                onModelChange(nextOption);
              }}
              value={selectedModelValue}
            >
              <SelectTrigger
                className="h-7 w-auto max-w-[260px] gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                disabled={allModelOptions.length === 0}
              >
                <SelectValue placeholder="Model">
                  <span className="flex items-center gap-1.5">
                    <ProviderIcon
                      className="size-3.5 shrink-0 text-muted-foreground/70"
                      provider={selectedProvider}
                    />
                    <span className="truncate">{selectedModelLabel}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                className="text-xs"
                side="top"
              >
                {allModelOptions.map((option) => (
                  <SelectItem
                    className="text-xs"
                    key={`${option.provider}:${option.id}`}
                    value={option.id}
                  >
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon
                        className="size-3.5 shrink-0 text-muted-foreground/70"
                        provider={option.provider}
                      />
                      <span className="truncate">{option.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {reasoningEffortOptions.length > 0 ? (
              <Select
                onValueChange={(value) =>
                  onReasoningEffortChange(value as ReasoningEffort)
                }
                value={selectedReasoningEffort}
              >
                <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                  <span className="truncate">{selectedReasoningLabel}</span>
                </SelectTrigger>
                <SelectContent className="text-xs" side="top">
                  {reasoningEffortOptions.map((option) => (
                    <SelectItem
                      className="text-xs"
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {selectedProvider === "openai" ? (
              <Select
                onValueChange={(value) =>
                  onCodexPermissionModeChange(value as CodexPermissionMode)
                }
                value={codexPermissionMode}
              >
                <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                  <Shield className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {getCodexPermissionModeLabel(codexPermissionMode)}
                  </span>
                </SelectTrigger>
                <SelectContent className="text-xs" side="top">
                  {CODEX_PERMISSION_MODE_OPTIONS.map((option) => (
                    <SelectItem
                      className="text-xs"
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : selectedProvider === "anthropic" ? (
              <Select
                onValueChange={(value) =>
                  onClaudePermissionModeChange(value as ClaudePermissionMode)
                }
                value={claudePermissionMode}
              >
                <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                  <Shield className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {getClaudePermissionModeLabel(claudePermissionMode)}
                  </span>
                </SelectTrigger>
                <SelectContent className="text-xs" side="top">
                  {CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
                    <SelectItem
                      className="text-xs"
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            <div className="ml-auto flex items-center gap-1">
              <UsageLimitsPopover provider={selectedProvider} />
              <Context
                maxTokens={contextWindow}
                modelId={modelId}
                usedTokens={estimatedUsedTokens}
              >
                <ContextTrigger className="h-7 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground" />
                <ContextContent side="top" align="end">
                  <ContextContentHeader />
                  <ContextContentBody className="space-y-1.5">
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                </ContextContent>
              </Context>
            </div>
          </div>
        </div>
      </Sparkles>
      <div className="mt-1 flex justify-end">
        <BranchSwitcher projectId={projectId} projectPath={projectPath} />
      </div>
    </div>
  </div>
);
