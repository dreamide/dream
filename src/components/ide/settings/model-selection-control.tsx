import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  resolveModelSpeedForModel,
  resolveReasoningEffortForModel,
} from "@/lib/ide-defaults";
import {
  getModelReasoningEfforts,
  getModelSpeedTiers,
  type ModelOption,
} from "@/lib/models";
import type { AiProvider, ModelSpeed, ReasoningEffort } from "@/types/ide";
import {
  getProviderLabel,
  MODEL_SPEED_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from "../ide-types";

export interface ModelSelectionGroup {
  models: ModelOption[];
  provider: AiProvider;
}

export interface ModelSelectionValue {
  model: string;
  modelSpeed: ModelSpeed;
  /** `null` is the model's default (medium). */
  reasoningEffort: ReasoningEffort | null;
}

const findModelEntry = (groups: ModelSelectionGroup[], modelId: string) => {
  for (const group of groups) {
    const model = group.models.find((item) => item.id === modelId);
    if (model) {
      return { model, provider: group.provider };
    }
  }

  return null;
};

const getModelCapabilities = (
  entry: ReturnType<typeof findModelEntry>,
): { reasoningEfforts: ReasoningEffort[]; speedTiers: ModelSpeed[] } => {
  if (!entry) {
    return { reasoningEfforts: [], speedTiers: [] };
  }

  return {
    reasoningEfforts: entry.model.reasoningEfforts?.length
      ? entry.model.reasoningEfforts
      : getModelReasoningEfforts(entry.provider, entry.model.id),
    speedTiers: entry.model.speedTiers?.length
      ? entry.model.speedTiers
      : getModelSpeedTiers(entry.provider, entry.model.id),
  };
};

/**
 * Model picker with the effort and speed selects the chosen model supports.
 * `value.model` must already be resolved to an enabled model id.
 */
export const ModelSelectionControl = ({
  groups,
  id,
  onChange,
  value,
}: {
  groups: ModelSelectionGroup[];
  id: string;
  onChange: (next: ModelSelectionValue) => void;
  value: ModelSelectionValue;
}) => {
  const modelT = useTranslations("models");
  const settingsT = useTranslations("settings");

  const selectedEntry = findModelEntry(groups, value.model);
  const capabilities = getModelCapabilities(selectedEntry);
  const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    capabilities.reasoningEfforts.includes(option.value),
  );
  const modelSpeedOptions = MODEL_SPEED_OPTIONS.filter((option) =>
    capabilities.speedTiers.includes(option.value),
  );
  const selectedReasoningEffort =
    capabilities.reasoningEfforts.length > 0
      ? (resolveReasoningEffortForModel(
          value.reasoningEffort,
          capabilities.reasoningEfforts,
        ) ?? "medium")
      : null;
  const selectedModelSpeed = resolveModelSpeedForModel(
    value.modelSpeed,
    capabilities.speedTiers,
  );

  const handleModelChange = (model: string) => {
    const nextCapabilities = getModelCapabilities(
      findModelEntry(groups, model),
    );
    onChange({
      model,
      modelSpeed: resolveModelSpeedForModel(
        value.modelSpeed,
        nextCapabilities.speedTiers,
      ),
      reasoningEffort: resolveReasoningEffortForModel(
        value.reasoningEffort,
        nextCapabilities.reasoningEfforts,
      ),
    });
  };

  return (
    <div className="grid w-full gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <Select
        onValueChange={(model) => handleModelChange(model ?? "")}
        value={value.model}
      >
        <SelectTrigger
          className="w-full"
          disabled={groups.length === 0}
          id={id}
        >
          <SelectValue placeholder={settingsT("enableModelFirst")}>
            {selectedEntry?.model.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-72">
          {groups.map((group) => (
            <SelectGroup key={group.provider}>
              {groups.length > 1 ? (
                <SelectLabel>{getProviderLabel(group.provider)}</SelectLabel>
              ) : null}
              {group.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      {reasoningEffortOptions.length > 0 && selectedReasoningEffort ? (
        <Select
          onValueChange={(effort) =>
            onChange({
              ...value,
              reasoningEffort:
                effort === "medium" ? null : (effort as ReasoningEffort),
            })
          }
          value={selectedReasoningEffort}
        >
          <SelectTrigger
            aria-label={settingsT("effort")}
            className="w-full sm:w-32"
          >
            <SelectValue>{modelT(selectedReasoningEffort)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{settingsT("effort")}</SelectLabel>
              {reasoningEffortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {modelT(option.value)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}

      {modelSpeedOptions.length > 0 ? (
        <Select
          onValueChange={(speed) =>
            onChange({ ...value, modelSpeed: speed as ModelSpeed })
          }
          value={selectedModelSpeed}
        >
          <SelectTrigger
            aria-label={settingsT("speed")}
            className="w-full sm:w-32"
          >
            <SelectValue>{modelT(selectedModelSpeed)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{settingsT("speed")}</SelectLabel>
              {modelSpeedOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {modelT(option.value)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
};
