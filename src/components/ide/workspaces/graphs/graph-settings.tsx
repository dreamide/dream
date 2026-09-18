import { useTranslations } from "next-intl";
import type { AgentGraph, GraphInput } from "@/types/agent-graphs";
import { InputsEditor } from "./outputs-editor";

export interface GraphSettingsProps {
  graph: AgentGraph;
  onInputsChange: (inputs: GraphInput[]) => void;
}

/** Shown in the inspector column when no node or edge is selected. */
export const GraphSettings = ({
  graph,
  onInputsChange,
}: GraphSettingsProps) => {
  const t = useTranslations("graphs");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2 text-xs font-medium">
        {t("workflowSettings")}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <InputsEditor
          graphId={graph.id}
          inputs={graph.inputs ?? []}
          onChange={onInputsChange}
        />
        <p className="text-xs text-muted-foreground">{t("selectHint")}</p>
      </div>
    </div>
  );
};
