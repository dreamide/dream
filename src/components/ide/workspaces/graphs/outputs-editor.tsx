import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type GraphInput,
  NODE_OUTPUT_TYPES,
  type NodeOutput,
  type NodeOutputType,
} from "@/types/agent-graphs";

const parseOptions = (raw: string): string[] =>
  raw.split(",").map((option) => option.trimStart());

const cleanOptions = (options: string[]): string[] =>
  options.map((option) => option.trim()).filter(Boolean);

export const createOutput = (existing: NodeOutput[]): NodeOutput => {
  const hasStatus = existing.some((output) => output.key === "status");
  return hasStatus
    ? {
        description: "",
        key: `output${existing.length + 1}`,
        options: [],
        required: true,
        saveToState: true,
        type: "text",
      }
    : {
        description: "",
        key: "status",
        options: ["success", "failed"],
        required: true,
        saveToState: false,
        type: "enum",
      };
};

export const createInput = (existing: GraphInput[]): GraphInput => ({
  description: "",
  key: `input${existing.length + 1}`,
  label: "",
  options: [],
  required: true,
  type: "text",
});

type DeclaredField = NodeOutput | GraphInput;

interface FieldsEditorProps<T extends DeclaredField> {
  addLabel: string;
  create: (existing: T[]) => T;
  fields: T[];
  help: string;
  idPrefix: string;
  onChange: (fields: T[]) => void;
  title: string;
}

export interface OutputsEditorProps {
  nodeId: string;
  onChange: (outputs: NodeOutput[]) => void;
  outputs: NodeOutput[];
}

export interface InputsEditorProps {
  graphId: string;
  inputs: GraphInput[];
  onChange: (inputs: GraphInput[]) => void;
}

/**
 * Declares what a step returns. The prompt contract, result validation and
 * the edge condition dropdowns are all generated from this list, so users
 * never describe output formats in the instructions.
 */
export const OutputsEditor = ({
  nodeId,
  onChange,
  outputs,
}: OutputsEditorProps) => {
  const t = useTranslations("graphs");
  return (
    <FieldsEditor
      addLabel={t("addOutput")}
      create={createOutput}
      fields={outputs}
      help={t("outputsHelp")}
      idPrefix={`node-output-${nodeId}`}
      onChange={onChange}
      title={t("outputs")}
    />
  );
};

/** Declares the form shown when a run is started. */
export const InputsEditor = ({
  graphId,
  inputs,
  onChange,
}: InputsEditorProps) => {
  const t = useTranslations("graphs");
  return (
    <FieldsEditor
      addLabel={t("addInput")}
      create={createInput}
      fields={inputs}
      help={t("inputsHelp")}
      idPrefix={`graph-input-${graphId}`}
      onChange={onChange}
      title={t("runInputs")}
    />
  );
};

const FieldsEditor = <T extends DeclaredField>({
  addLabel,
  create,
  fields: outputs,
  help,
  idPrefix,
  onChange,
  title,
}: FieldsEditorProps<T>) => {
  const t = useTranslations("graphs");

  const update = (index: number, patch: Partial<DeclaredField>) =>
    onChange(
      outputs.map((output, position) =>
        position === index ? ({ ...output, ...patch } as T) : output,
      ),
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{title}</Label>
        <Button
          className="ml-auto"
          onClick={() => onChange([...outputs, create(outputs)])}
          size="xs"
          type="button"
          variant="outline"
        >
          <Plus className="size-3" />
          {addLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>

      {outputs.map((output, index) => {
        const id = `${idPrefix}-${index}`;
        return (
          <div
            className="space-y-2 rounded-md border border-border p-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: keys are edited in place
            key={index}
          >
            <div className="grid grid-cols-[1fr_6.5rem_auto] items-center gap-2">
              <Input
                aria-label={t("outputName")}
                className="font-mono text-xs"
                onChange={(event) =>
                  update(index, {
                    key: event.target.value.replace(/[^A-Za-z0-9_]/g, ""),
                  })
                }
                placeholder={t("outputName")}
                value={output.key}
              />
              <Select
                onValueChange={(value) =>
                  value !== null &&
                  update(index, { type: value as NodeOutputType })
                }
                value={output.type}
              >
                <SelectTrigger
                  aria-label={t("valueType")}
                  className="w-full min-w-0"
                >
                  <SelectValue>{t(`outputType_${output.type}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {NODE_OUTPUT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`outputType_${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() =>
                  onChange(outputs.filter((_, position) => position !== index))
                }
                size="icon-xs"
                title={t("deleteOutput")}
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>

            {"label" in output ? (
              <Input
                aria-label={t("inputLabel")}
                className="text-xs"
                onChange={(event) =>
                  update(index, { label: event.target.value })
                }
                placeholder={t("inputLabelPlaceholder")}
                value={output.label}
              />
            ) : null}

            {output.type === "enum" ? (
              <Input
                aria-label={t("outputOptions")}
                className="font-mono text-xs"
                onBlur={() =>
                  update(index, { options: cleanOptions(output.options) })
                }
                onChange={(event) =>
                  update(index, { options: parseOptions(event.target.value) })
                }
                placeholder={t("outputOptionsPlaceholder")}
                value={output.options.join(", ")}
              />
            ) : null}

            <Input
              aria-label={t("outputDescription")}
              className="text-xs"
              onChange={(event) =>
                update(index, { description: event.target.value })
              }
              placeholder={t("outputDescriptionPlaceholder")}
              value={output.description}
            />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <label
                className="flex items-center gap-1.5"
                htmlFor={`${id}-req`}
              >
                <Checkbox
                  checked={output.required}
                  id={`${id}-req`}
                  onCheckedChange={(checked) =>
                    update(index, { required: checked === true })
                  }
                />
                {t("outputRequired")}
              </label>
              {"saveToState" in output ? (
                <label
                  className="flex items-center gap-1.5"
                  htmlFor={`${id}-share`}
                >
                  <Checkbox
                    checked={output.saveToState}
                    id={`${id}-share`}
                    onCheckedChange={(checked) =>
                      update(index, { saveToState: checked === true })
                    }
                  />
                  {t("outputShare")}
                </label>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};
