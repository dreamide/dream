import { useTranslations } from "next-intl";
import { type FormEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export type McpServerFormTarget = McpServerConfig | "new";

const TRANSPORTS: McpServerTransport[] = ["stdio", "http", "sse"];

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

const toFormState = (target: McpServerFormTarget): FormState =>
  target !== "new"
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

export const McpSubviewHeader = ({
  description,
  title,
}: {
  description?: string;
  title: string;
}) => (
  <div className="min-w-0 space-y-1">
    <h3 className="font-medium text-sm">{title}</h3>
    {description ? (
      <p className="text-muted-foreground text-sm">{description}</p>
    ) : null}
  </div>
);

/**
 * Inline add/edit form rendered in place of the server list. The parent
 * remounts it (via `key`) whenever the target changes.
 */
export const McpServerForm = ({
  existingNames,
  onCancel,
  onSubmit,
  target,
}: {
  existingNames: string[];
  onCancel: () => void;
  onSubmit: (input: McpServerInput) => void;
  target: McpServerFormTarget;
}) => {
  const commonT = useTranslations("common");
  const settingsT = useTranslations("settings");
  const [form, setForm] = useState<FormState>(() => toFormState(target));

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
  const originalName = target !== "new" ? target.name : null;
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

  const transportLabels: Record<McpServerTransport, string> = {
    http: settingsT("mcpTransportHttp"),
    sse: settingsT("mcpTransportSse"),
    stdio: settingsT("mcpTransportStdio"),
  };

  const keyValueError = keyValueErrors[0];
  const keyValueMessage = (
    <p
      className={
        keyValueError
          ? "text-destructive text-xs"
          : "text-muted-foreground text-xs"
      }
    >
      {keyValueError
        ? settingsT("mcpKeyValueInvalid", { line: keyValueError.line })
        : settingsT("mcpKeyValueHint")}
    </p>
  );

  return (
    <form className="max-w-2xl space-y-4" onSubmit={handleSubmit}>
      <McpSubviewHeader
        title={
          target === "new"
            ? settingsT("mcpAddServer")
            : settingsT("mcpEditServer")
        }
      />

      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
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
          <Select
            onValueChange={(value) =>
              update("transport", value as McpServerTransport)
            }
            value={form.transport}
          >
            <SelectTrigger className="w-full" id="mcp-server-transport">
              <SelectValue>{transportLabels[form.transport]}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              {TRANSPORTS.map((transport) => (
                <SelectItem key={transport} value={transport}>
                  {transportLabels[transport]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            {keyValueMessage}
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
            {keyValueMessage}
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="mcp-server-enabled">{settingsT("mcpEnabled")}</Label>
        <Switch
          checked={form.enabled}
          id="mcp-server-enabled"
          onCheckedChange={(checked) => update("enabled", checked)}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} type="button" variant="outline">
          {commonT("cancel")}
        </Button>
        <Button disabled={!canSubmit} type="submit">
          {commonT("save")}
        </Button>
      </div>
    </form>
  );
};
