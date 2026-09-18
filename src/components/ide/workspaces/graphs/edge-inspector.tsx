import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
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
import {
  EDGE_CONDITION_OPERATORS,
  type EdgeCondition,
  type EdgeConditionOperator,
  type GraphEdge,
} from "@/types/agent-graphs";

type ValueType = "string" | "number" | "boolean";

const valueTypeOf = (value: EdgeCondition["value"]): ValueType =>
  typeof value === "number"
    ? "number"
    : typeof value === "boolean"
      ? "boolean"
      : "string";

const coerceValue = (raw: string, type: ValueType): EdgeCondition["value"] => {
  if (type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (type === "boolean") {
    return raw === "true";
  }
  return raw;
};

const OPERATOR_NEEDS_VALUE: Record<EdgeConditionOperator, boolean> = {
  contains: true,
  eq: true,
  exists: false,
  neq: true,
  not_exists: false,
};

export interface EdgeInspectorProps {
  edge: GraphEdge;
  locked: boolean;
  onChange: (updater: (edge: GraphEdge) => GraphEdge) => void;
  onDelete: () => void;
  sourceName: string;
  targetName: string;
}

export const EdgeInspector = ({
  edge,
  locked,
  onChange,
  onDelete,
  sourceName,
  targetName,
}: EdgeInspectorProps) => {
  const t = useTranslations("graphs");
  const condition = edge.condition;
  const valueType = valueTypeOf(condition?.value);
  const needsValue = condition
    ? OPERATOR_NEEDS_VALUE[condition.operator]
    : false;

  const setCondition = (patch: Partial<EdgeCondition>) =>
    onChange((current) => ({
      ...current,
      condition: {
        field: "status",
        operator: "eq",
        value: "",
        ...(current.condition ?? {}),
        ...patch,
      },
    }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">{sourceName}</span>
          <span className="text-muted-foreground"> → </span>
          <span className="font-medium">{targetName}</span>
        </div>
        <Button
          disabled={locked}
          onClick={onDelete}
          size="icon-xs"
          title={t("deleteEdge")}
          type="button"
          variant="ghost"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="space-y-1.5">
          <Label htmlFor={`edge-mode-${edge.id}`}>{t("when")}</Label>
          <Select
            onValueChange={(value) => {
              if (value === null) return;
              if (value === "always") {
                onChange((current) => ({ ...current, condition: null }));
              } else {
                setCondition({});
              }
            }}
            value={condition ? "condition" : "always"}
          >
            <SelectTrigger
              className="w-full min-w-0"
              id={`edge-mode-${edge.id}`}
            >
              <SelectValue>
                {condition ? t("conditionMatches") : t("always")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              <SelectItem value="always">{t("always")}</SelectItem>
              <SelectItem value="condition">{t("conditionMatches")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {condition ? t("conditionHint") : t("alwaysHint")}
          </p>
        </div>

        {condition ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`edge-field-${edge.id}`}>{t("field")}</Label>
              <Input
                className="font-mono text-xs"
                id={`edge-field-${edge.id}`}
                onChange={(event) =>
                  setCondition({ field: event.target.value })
                }
                placeholder="status"
                value={condition.field}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`edge-operator-${edge.id}`}>
                {t("operator")}
              </Label>
              <Select
                onValueChange={(value) =>
                  value !== null &&
                  setCondition({
                    operator: value as EdgeConditionOperator,
                  })
                }
                value={condition.operator}
              >
                <SelectTrigger
                  className="w-full min-w-0"
                  id={`edge-operator-${edge.id}`}
                >
                  <SelectValue>
                    {t(`operator_${condition.operator}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {EDGE_CONDITION_OPERATORS.map((operator) => (
                    <SelectItem key={operator} value={operator}>
                      {t(`operator_${operator}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsValue ? (
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`edge-value-${edge.id}`}>{t("value")}</Label>
                  {valueType === "boolean" ? (
                    <Select
                      onValueChange={(value) =>
                        value !== null &&
                        setCondition({ value: value === "true" })
                      }
                      value={String(condition.value ?? false)}
                    >
                      <SelectTrigger
                        className="w-full min-w-0"
                        id={`edge-value-${edge.id}`}
                      >
                        <SelectValue>
                          {String(condition.value ?? false)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" alignItemWithTrigger={false}>
                        <SelectItem value="true">true</SelectItem>
                        <SelectItem value="false">false</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      className="font-mono text-xs"
                      id={`edge-value-${edge.id}`}
                      onChange={(event) =>
                        setCondition({
                          value: coerceValue(event.target.value, valueType),
                        })
                      }
                      type={valueType === "number" ? "number" : "text"}
                      value={String(condition.value ?? "")}
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`edge-value-type-${edge.id}`}>
                    {t("valueType")}
                  </Label>
                  <Select
                    onValueChange={(value) =>
                      value !== null &&
                      setCondition({
                        value: coerceValue(
                          String(condition.value ?? ""),
                          value as ValueType,
                        ),
                      })
                    }
                    value={valueType}
                  >
                    <SelectTrigger
                      className="w-full min-w-0"
                      id={`edge-value-type-${edge.id}`}
                    >
                      <SelectValue>
                        {t(
                          `valueType${valueType === "string" ? "Text" : valueType === "number" ? "Number" : "Boolean"}`,
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      <SelectItem value="string">
                        {t("valueTypeText")}
                      </SelectItem>
                      <SelectItem value="number">
                        {t("valueTypeNumber")}
                      </SelectItem>
                      <SelectItem value="boolean">
                        {t("valueTypeBoolean")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={`edge-priority-${edge.id}`}>
                {t("priority")}
              </Label>
              <Input
                id={`edge-priority-${edge.id}`}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  onChange((current) => ({
                    ...current,
                    priority: Number.isFinite(value) ? value : 0,
                  }));
                }}
                type="number"
                value={edge.priority}
              />
              <p className="text-xs text-muted-foreground">
                {t("priorityHint")}
              </p>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};
