import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  formatArgsLines,
  formatKeyValueLines,
  isValidMcpServerName,
  type McpServerInput,
  parseArgsLines,
  parseKeyValueLines,
} from "@/lib/mcp-servers";
import type { McpServerConfig, McpServerTransport } from "@/types/ide";

export type McpServerDialogTarget = McpServerConfig | "new" | null;

type FormState = {
  args: string;
  command: string;
  enabled: boolean;
  env: string;
  headers: string;
  name: string;
  transport: McpServerTransport;
  url: string;
};

const EMPTY_FORM: FormState = {
  args: "",
  command: "",
  enabled: true,
  env: "",
  headers: "",
  name: "",
  transport: "stdio",
  url: "",
};

const toFormState = (target: McpServerDialogTarget): FormState =>
  target && target !== "new"
    ? {
        args: formatArgsLines(target.args),
        command: target.command,
        enabled: target.enabled,
        env: formatKeyValueLines(target.env),
        headers: formatKeyValueLines(target.headers),
        name: target.name,
        transport: target.transport,
        url: target.url,
      }
    : EMPTY_FORM;

const isValidUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const McpServerDialog = ({
  existingNames,
  onClose,
  onSubmit,
  target,
}: {
  existingNames: string[];
  onClose: () => void;
  onSubmit: (input: McpServerInput) => void;
  target: McpServerDialogTarget;
}) => {
  const commonT = useTranslations("common");
  const settingsT = useTranslations("settings");
  const [form, setForm] = useState<FormState>(() => toFormState(target));

  useEffect(() => {
    setForm(toFormState(target));
  }, [target]);

  const update = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key],
  ) => setForm((previous) => ({ ...previous, [key]: value }));

  const envResult = useMemo(() => parseKeyValueLines(form.env), [form.env]);
  const headersResult = useMemo(
    () => parseKeyValueLines(form.headers),
    [form.headers],
  );
  const trimmedName = form.name.trim();
  const originalName = target && target !== "new" ? target.name : null;
  const nameInvalid =
    trimmedName.length > 0 && !isValidMcpServerName(trimmedName);
  const nameDuplicate =
    trimmedName.length > 0 &&
    trimmedName !== originalName &&
    existingNames.includes(trimmedName);
  const isStdio = form.transport === "stdio";
  const commandMissing = isStdio && form.command.trim().length === 0;
  const urlInvalid = !isStdio && !isValidUrl(form.url.trim());
  const keyValueErrors = isStdio ? envResult.errors : headersResult.errors;
  const canSubmit =
    trimmedName.length > 0 &&
    !nameInvalid &&
    !nameDuplicate &&
    !commandMissing &&
    !urlInvalid &&
    keyValueErrors.length === 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSubmit({
      args: isStdio ? parseArgsLines(form.args) : [],
      command: isStdio ? form.command.trim() : "",
      enabled: form.enabled,
      env: isStdio ? envResult.values : {},
      headers: isStdio ? {} : headersResult.values,
      name: trimmedName,
      transport: form.transport,
      url: isStdio ? "" : form.url.trim(),
    });
  };

  const keyValueError = keyValueErrors[0];

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={target !== null}
    >
      <DialogContent className="sm:max-w-lg">
        <form className="space-y-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {target === "new"
                ? settingsT("mcpAddServer")
                : settingsT("mcpEditServer")}
            </DialogTitle>
            <DialogDescription>{settingsT("mcpSecretsNote")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <Label htmlFor="mcp-server-name">{settingsT("mcpName")}</Label>
              <Input
                aria-invalid={nameInvalid || nameDuplicate}
                autoFocus
                id="mcp-server-name"
                onChange={(event) => update("name", event.target.value)}
                placeholder="github"
                value={form.name}
              />
              {nameInvalid ? (
                <p className="text-destructive text-xs">
                  {settingsT("mcpNameInvalid")}
                </p>
              ) : nameDuplicate ? (
                <p className="text-destructive text-xs">
                  {settingsT("mcpNameDuplicate")}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-server-transport">
                {settingsT("mcpTransport")}
              </Label>
              <NativeSelect className="w-full">
                <select
                  id="mcp-server-transport"
                  onChange={(event) =>
                    update(
                      "transport",
                      event.target.value as McpServerTransport,
                    )
                  }
                  value={form.transport}
                >
                  <NativeSelectOption value="stdio">
                    {settingsT("mcpTransportStdio")}
                  </NativeSelectOption>
                  <NativeSelectOption value="http">
                    {settingsT("mcpTransportHttp")}
                  </NativeSelectOption>
                  <NativeSelectOption value="sse">
                    {settingsT("mcpTransportSse")}
                  </NativeSelectOption>
                </select>
              </NativeSelect>
            </div>
          </div>

          {isStdio ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-server-command">
                  {settingsT("mcpCommand")}
                </Label>
                <Input
                  className="font-mono"
                  id="mcp-server-command"
                  onChange={(event) => update("command", event.target.value)}
                  placeholder="npx"
                  value={form.command}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-server-args">{settingsT("mcpArgs")}</Label>
                <Textarea
                  className="min-h-20 font-mono text-xs"
                  id="mcp-server-args"
                  onChange={(event) => update("args", event.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  value={form.args}
                />
                <p className="text-muted-foreground text-xs">
                  {settingsT("mcpArgsHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-server-env">{settingsT("mcpEnv")}</Label>
                <Textarea
                  aria-invalid={envResult.errors.length > 0}
                  className="min-h-20 font-mono text-xs"
                  id="mcp-server-env"
                  onChange={(event) => update("env", event.target.value)}
                  placeholder="GITHUB_TOKEN=ghp_..."
                  value={form.env}
                />
                <p
                  className={
                    keyValueError
                      ? "text-destructive text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {keyValueError
                    ? settingsT("mcpKeyValueInvalid", {
                        line: keyValueError.line,
                      })
                    : settingsT("mcpKeyValueHint")}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-server-url">{settingsT("mcpUrl")}</Label>
                <Input
                  aria-invalid={form.url.trim().length > 0 && urlInvalid}
                  className="font-mono"
                  id="mcp-server-url"
                  onChange={(event) => update("url", event.target.value)}
                  placeholder="https://example.com/mcp"
                  value={form.url}
                />
                {form.url.trim().length > 0 && urlInvalid ? (
                  <p className="text-destructive text-xs">
                    {settingsT("mcpUrlInvalid")}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-server-headers">
                  {settingsT("mcpHeaders")}
                </Label>
                <Textarea
                  aria-invalid={headersResult.errors.length > 0}
                  className="min-h-20 font-mono text-xs"
                  id="mcp-server-headers"
                  onChange={(event) => update("headers", event.target.value)}
                  placeholder="Authorization=Bearer ..."
                  value={form.headers}
                />
                <p
                  className={
                    keyValueError
                      ? "text-destructive text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {keyValueError
                    ? settingsT("mcpKeyValueInvalid", {
                        line: keyValueError.line,
                      })
                    : settingsT("mcpKeyValueHint")}
                </p>
              </div>
            </>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="mcp-server-enabled">
              {settingsT("mcpEnabled")}
            </Label>
            <Switch
              checked={form.enabled}
              id="mcp-server-enabled"
              onCheckedChange={(checked) => update("enabled", checked)}
            />
          </div>

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {commonT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
