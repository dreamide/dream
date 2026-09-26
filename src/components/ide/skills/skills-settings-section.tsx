import { FolderGit2, FolderOpen, Package, Plus, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import type { AiProvider, ProviderSkill } from "@/types/ide";
import { fetchProviderSkills } from "../chat/provider-skills";
import { useIdeStore } from "../ide-store";
import { CreateSkillDialog } from "./create-skill-dialog";
import {
  readSkillFileRequest,
  SKILL_TOGGLE_PROVIDERS,
  type SkillFileContents,
  setSkillEnabledRequest,
} from "./skills-api";

const SKILL_PROVIDERS: AiProvider[] = [
  "anthropic",
  "openai",
  "opencode",
  "cursor",
];

const NO_PROJECT_VALUE = "__none__";

/**
 * Settings > Skills: what each agent CLI will load for a project, read the
 * way that CLI reads it. Skills live on disk (or in the provider's own
 * config), so this page lists and scaffolds them rather than storing them.
 */
export const SkillsSettingsSection = () => {
  const t = useTranslations("skills");
  const providerT = useTranslations("provider");
  const projects = useIdeStore((state) => state.projects);
  const activeProjectId = useIdeStore((state) => state.activeProjectId);
  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const [projectId, setProjectId] = useState<string | null>(activeProjectId);
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    contents: SkillFileContents | null;
    error: string | null;
    path: string;
  } | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const project =
    projects.find((item) => item.id === projectId) ??
    projects.find((item) => item.id === activeProjectId) ??
    null;
  const projectPath = project?.path ?? "";

  const load = useCallback(
    async (force: boolean) => {
      setIsLoading(true);
      setActionError(null);
      try {
        const result = await fetchProviderSkills(provider, projectPath, {
          force,
        });
        setSkills(result.skills);
        setErrors(result.errors);
      } finally {
        setIsLoading(false);
      }
    },
    [projectPath, provider],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const skillKey = (skill: ProviderSkill) =>
    `${skill.source}:${skill.path || skill.name}`;
  const selectedSkill =
    skills.find((skill) => skillKey(skill) === selectedKey) ??
    skills[0] ??
    null;

  // Load the selected skill's SKILL.md for the preview pane.
  const selectedPath = selectedSkill?.path ?? "";
  useEffect(() => {
    if (!selectedPath) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview({ contents: null, error: null, path: selectedPath });
    readSkillFileRequest({
      path: selectedPath,
      projectPath: projectPath || undefined,
      provider,
    })
      .then((contents) => {
        if (!cancelled) {
          setPreview({ contents, error: null, path: selectedPath });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreview({
            contents: null,
            error: error instanceof Error ? error.message : t("previewFailed"),
            path: selectedPath,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, provider, selectedPath, t]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ProviderSkill[]>();
    for (const skill of skills) {
      const list = groups.get(skill.scope) ?? [];
      list.push(skill);
      groups.set(skill.scope, list);
    }
    const order = ["project", "user", "plugin", "admin", "system"];
    return order
      .filter((scope) => groups.has(scope))
      .map((scope) => ({ scope, skills: groups.get(scope) ?? [] }));
  }, [skills]);

  const scopeLabel = (scope: string) => {
    switch (scope) {
      case "project":
        return t("scopeProject");
      case "system":
        return t("scopeSystem");
      case "plugin":
        return t("scopePlugin");
      case "admin":
        return t("scopeAdmin");
      default:
        return t("scopeUser");
    }
  };

  const providerLabel = (value: AiProvider) => {
    switch (value) {
      case "anthropic":
        return providerT("claudeCodeCli");
      case "openai":
        return providerT("codexCli");
      case "opencode":
        return providerT("opencodeCli");
      default:
        return providerT("cursorAgentCli");
    }
  };

  const canToggle = SKILL_TOGGLE_PROVIDERS.includes(provider);

  const handleToggle = async (skill: ProviderSkill, enabled: boolean) => {
    const key = skillKey(skill);
    setPendingToggle(key);
    setActionError(null);
    try {
      await setSkillEnabledRequest({
        enabled,
        name: skill.name,
        path: skill.path || undefined,
        provider,
      });
      await load(true);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t("updateFailed"),
      );
    } finally {
      setPendingToggle(null);
    }
  };

  const openFolder = (skill: ProviderSkill) => {
    const target = skill.directory || skill.path;
    if (target) {
      void getDesktopApi()?.openPath(target);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{t("title")}</h3>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={isLoading}
            onClick={() => void load(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            {isLoading ? (
              <Spinner className="size-4" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {t("refresh")}
          </Button>
          <Button
            onClick={() => setShowCreateDialog(true)}
            size="sm"
            type="button"
          >
            <Plus className="size-4" />
            {t("newSkill")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          onValueChange={(value) => {
            if (typeof value === "string") {
              setProvider(value as AiProvider);
              setSelectedKey(null);
            }
          }}
          value={provider}
        >
          <TabsList>
            {SKILL_PROVIDERS.map((item) => (
              <TabsTrigger key={item} value={item}>
                <span className="flex items-center gap-1.5">
                  <ProviderIcon className="size-3.5" provider={item} />
                  {providerLabel(item)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select
          onValueChange={(value) => {
            if (typeof value === "string") {
              setProjectId(value === NO_PROJECT_VALUE ? null : value);
              setSelectedKey(null);
            }
          }}
          value={project?.id ?? NO_PROJECT_VALUE}
        >
          <SelectTrigger className="h-8 w-auto max-w-[280px] text-xs">
            <SelectValue placeholder={t("project")}>
              <span className="flex items-center gap-1.5">
                <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {project ? project.name : t("noProject")}
                </span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="text-xs">
            <SelectItem className="text-xs" value={NO_PROJECT_VALUE}>
              {t("noProject")}
            </SelectItem>
            {projects.map((item) => (
              <SelectItem className="text-xs" key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {errors.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      ) : null}
      {actionError ? (
        <p className="text-destructive text-sm" role="alert">
          {actionError}
        </p>
      ) : null}

      {skills.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-md border border-dashed p-4 text-center">
          <p className="text-muted-foreground text-sm">
            {isLoading ? t("loading") : t("empty")}
          </p>
        </div>
      ) : (
        <div className="grid min-h-[480px] grid-cols-[minmax(0,24rem)_minmax(0,1fr)] rounded-md border bg-white dark:bg-surface-950">
          {/* The list sticks below the settings header (h-12) and top fade
              (24px) and scrolls on its own; the detail pane scrolls with the
              page, so a long SKILL.md never drags the list out of view. */}
          <div className="sticky top-6 max-h-[calc(100dvh-5.5rem)] min-w-0 self-start overflow-y-auto overscroll-contain p-2">
            {grouped.map((group) => (
              <div className="mb-3" key={group.scope}>
                <p className="px-3 py-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  {scopeLabel(group.scope)}
                </p>
                <ul className="space-y-1">
                  {group.skills.map((skill) => {
                    const key = skillKey(skill);
                    const isSelected = key === skillKey(selectedSkill ?? skill);
                    return (
                      <li
                        className={cn(
                          "flex items-center gap-1 rounded-md pr-2 transition-colors",
                          isSelected && selectedSkill
                            ? "bg-muted"
                            : "bg-muted/50 hover:bg-muted",
                          !skill.enabled && "opacity-60",
                        )}
                        key={key}
                      >
                        <button
                          aria-current={
                            isSelected && selectedSkill ? "true" : undefined
                          }
                          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:underline"
                          onClick={() => setSelectedKey(key)}
                          title={skill.path}
                          type="button"
                        >
                          <Package className="size-3.5 shrink-0 text-info-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium">{skill.name}</span>
                            {skill.kind === "command" ? (
                              <span className="ml-2 text-muted-foreground text-xs">
                                {t("command")}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        {canToggle && skill.scope !== "system" ? (
                          <Switch
                            aria-label={t("enabled")}
                            checked={skill.enabled}
                            disabled={pendingToggle === key}
                            onCheckedChange={(checked) =>
                              void handleToggle(skill, checked)
                            }
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          <div className="min-w-0 space-y-4 border-l p-4">
            {selectedSkill ? (
              <>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold text-sm">
                      {selectedSkill.displayName || selectedSkill.name}
                    </h4>
                    {selectedSkill.displayName ? (
                      <span className="text-muted-foreground text-sm">
                        {selectedSkill.displayName}
                      </span>
                    ) : null}
                    <span className="rounded border border-surface-200 px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide dark:border-surface-700">
                      {scopeLabel(selectedSkill.scope)}
                    </span>
                    {selectedSkill.userInvocationOnly ? (
                      <span className="rounded border border-surface-200 px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide dark:border-surface-700">
                        {t("userInvocationOnly")}
                      </span>
                    ) : null}
                    {!selectedSkill.enabled ? (
                      <span className="rounded border border-surface-200 px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide dark:border-surface-700">
                        {t("disabled")}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {selectedSkill.description || t("noDescription")}
                  </p>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{t("sourceLabel")}</dt>
                  <dd className="font-mono">{selectedSkill.source}</dd>
                  {selectedSkill.pluginId ? (
                    <>
                      <dt className="text-muted-foreground">
                        {t("scopePlugin")}
                      </dt>
                      <dd className="font-mono">{selectedSkill.pluginId}</dd>
                    </>
                  ) : null}
                  {selectedSkill.path ? (
                    <>
                      <dt className="text-muted-foreground">
                        {t("pathLabel")}
                      </dt>
                      <dd className="break-all font-mono">
                        {selectedSkill.path}
                      </dd>
                    </>
                  ) : null}
                  {selectedSkill.argumentHint ? (
                    <>
                      <dt className="text-muted-foreground">
                        {t("argumentsLabel")}
                      </dt>
                      <dd className="font-mono">
                        {selectedSkill.argumentHint}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {selectedSkill.directory ? (
                  <Button
                    onClick={() => openFolder(selectedSkill)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <FolderOpen className="size-4" />
                    {t("openFolder")}
                  </Button>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  {t("usageHint", { mention: `$${selectedSkill.name}` })}
                </p>
                {selectedSkill.path ? (
                  <div className="space-y-2 border-t pt-4">
                    <p className="font-medium font-mono text-muted-foreground text-xs">
                      {selectedSkill.path.split(/[\\/]/).pop()}
                    </p>
                    {preview?.contents ? (
                      <div className="rounded-md border border-surface-200 bg-surface-50 p-4 text-sm dark:border-surface-800 dark:bg-surface-900">
                        <MessageResponse>
                          {preview.contents.body}
                        </MessageResponse>
                      </div>
                    ) : preview?.error ? (
                      <p className="text-destructive text-xs">
                        {preview.error}
                      </p>
                    ) : (
                      <p className="flex items-center gap-2 text-muted-foreground text-xs">
                        <Spinner className="size-3.5" />
                        {t("previewLoading")}
                      </p>
                    )}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}

      {showCreateDialog ? (
        <CreateSkillDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => void load(true)}
          projectPath={projectPath || null}
        />
      ) : null}
    </div>
  );
};
