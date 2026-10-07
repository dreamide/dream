import { Pencil, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import {
  assignBinding,
  type Chord,
  chordFromEvent,
  findChordOwner,
  formatChord,
  getChordProblem,
  getEffectiveBinding,
  isBindingCustomized,
  type KeyPlatform,
  parseChord,
  RESERVED_SHORTCUTS,
  resetBinding,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORIES,
  type ShortcutActionId,
} from "@/lib/keybindings";
import { cn } from "@/lib/utils";
import { useIdeStore } from "../ide-store";
import { ShortcutKeys } from "../shortcuts/shortcut-keys";
import { useKeyPlatform } from "../shortcuts/shortcuts";
import { SettingsGroup } from "./settings-shared";

const EMPTY_OVERRIDES: Record<string, string | null> = {};

const ROW_CLASS_NAME =
  "flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2";

const MODIFIER_HINT: Record<KeyPlatform, string> = {
  mac: "⌘, ⌃, ⌥",
  other: "Ctrl, Alt",
};

/**
 * Captures one chord. Bare Enter saves it, bare Escape cancels; everything
 * else is recorded, so Enter and Escape can still be part of a chord with
 * modifiers. Key events stop here, so nothing else in the app reacts while
 * recording.
 */
const ShortcutRecorder = ({
  actionId,
  onCancel,
  onSave,
}: {
  actionId: ShortcutActionId;
  onCancel: () => void;
  onSave: (chord: Chord) => void;
}) => {
  const t = useTranslations("shortcuts");
  const commonT = useTranslations("common");
  const platform = useKeyPlatform();
  const overrides = useIdeStore(
    (state) => state.settings.keybindings ?? EMPTY_OVERRIDES,
  );
  const [captured, setCaptured] = useState<Chord | null>(null);
  const boxRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const problem = captured ? getChordProblem(captured) : null;
  const owner =
    captured && !problem
      ? findChordOwner(captured, overrides, platform, actionId)
      : null;
  const canSave = captured !== null && !problem && owner?.kind !== "reserved";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const bare =
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (bare && event.key === "Escape") {
      onCancel();
      return;
    }
    if (bare && event.key === "Enter" && captured) {
      if (canSave) {
        onSave(captured);
      }
      return;
    }

    const chord = chordFromEvent(event.nativeEvent, platform);
    if (chord) {
      setCaptured(chord);
    }
  };

  let message: string | null = null;
  if (problem === "needsModifier") {
    message = t("needsModifier", { modifiers: MODIFIER_HINT[platform] });
  } else if (owner?.kind === "reserved") {
    message = t("reservedConflict", { name: t(`reserved.${owner.id}`) });
  } else if (owner?.kind === "action") {
    message = t("actionConflict", { name: t(`actions.${owner.id}`) });
  }

  return (
    <div className="flex w-full flex-col items-end gap-1.5 md:w-auto">
      <div className="flex items-center gap-2">
        {/* A button so it takes focus and keys; every key is recorded
            rather than activating it. */}
        <button
          aria-label={t("recordLabel", { action: t(`actions.${actionId}`) })}
          className="flex h-8 min-w-48 items-center justify-center rounded-md border border-ring bg-surface-50 px-3 text-sm outline-none ring-2 ring-ring/30 dark:bg-surface-900"
          onKeyDown={handleKeyDown}
          ref={boxRef}
          type="button"
        >
          <span aria-live="polite">
            {captured ? (
              <ShortcutKeys chord={captured} />
            ) : (
              <span className="text-muted-foreground">{t("recordPrompt")}</span>
            )}
          </span>
        </button>
        <Button
          disabled={!canSave}
          onClick={() => captured && onSave(captured)}
          size="sm"
          type="button"
        >
          {commonT("save")}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {commonT("cancel")}
        </Button>
      </div>
      {message ? (
        <p
          className={cn(
            "text-xs",
            problem || owner?.kind === "reserved"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
};

const ShortcutRow = ({
  actionId,
  editing,
  onEdit,
  onStopEditing,
}: {
  actionId: ShortcutActionId;
  editing: boolean;
  onEdit: () => void;
  onStopEditing: () => void;
}) => {
  const t = useTranslations("shortcuts");
  const platform = useKeyPlatform();
  const overrides = useIdeStore(
    (state) => state.settings.keybindings ?? EMPTY_OVERRIDES,
  );
  const setSettings = useIdeStore((state) => state.setSettings);
  const binding = getEffectiveBinding(actionId, overrides, platform);
  const customized = isBindingCustomized(actionId, overrides, platform);
  const label = t(`actions.${actionId}`);

  const update = (
    change: (
      current: Record<string, string | null>,
    ) => Record<string, string | null>,
  ) =>
    setSettings((previous) => ({
      ...previous,
      keybindings: change(previous.keybindings ?? {}),
    }));

  return (
    <div className={ROW_CLASS_NAME} data-shortcut-action={actionId}>
      <span className="flex min-w-0 items-center gap-2 font-medium text-sm">
        {label}
        {customized ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            title={t("customized")}
          />
        ) : null}
      </span>

      {editing ? (
        <ShortcutRecorder
          actionId={actionId}
          onCancel={onStopEditing}
          onSave={(chord) => {
            update((current) =>
              assignBinding(current, actionId, chord, platform),
            );
            onStopEditing();
          }}
        />
      ) : (
        <div className="flex items-center gap-1">
          <button
            aria-label={t("change", { action: label })}
            className="flex h-8 min-w-24 items-center justify-end rounded-md px-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={onEdit}
            title={t("editShortcut")}
            type="button"
          >
            {binding ? (
              <ShortcutKeys chord={binding} />
            ) : (
              <span className="text-muted-foreground">{t("notAssigned")}</span>
            )}
          </button>
          <Button
            aria-label={t("change", { action: label })}
            onClick={onEdit}
            size="icon-sm"
            title={t("editShortcut")}
            type="button"
            variant="ghost"
          >
            <Pencil className="size-3.5" />
          </Button>
          {/* One slot: Reset once the shortcut differs from the default
              (including after Delete), otherwise Delete. */}
          {customized ? (
            <Button
              aria-label={t("reset", { action: label })}
              onClick={() =>
                update((current) => resetBinding(current, actionId, platform))
              }
              size="icon-sm"
              title={t("resetShortcut")}
              type="button"
              variant="ghost"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : (
            <Button
              aria-label={t("remove", { action: label })}
              className={cn(!binding && "invisible")}
              disabled={!binding}
              onClick={() =>
                update((current) =>
                  assignBinding(current, actionId, null, platform),
                )
              }
              size="icon-sm"
              title={t("deleteShortcut")}
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Settings > Keyboard shortcuts: every customizable shortcut by category,
 * each changed by recording a new key combination, plus the fixed shortcuts
 * for reference. Only differences from the defaults are saved.
 */
export const KeyboardShortcutsSection = () => {
  const t = useTranslations("shortcuts");
  const platform = useKeyPlatform();
  const overrides = useIdeStore(
    (state) => state.settings.keybindings ?? EMPTY_OVERRIDES,
  );
  const setSettings = useIdeStore((state) => state.setSettings);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<ShortcutActionId | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (label: string, chord: Chord | null) =>
    normalizedQuery === "" ||
    label.toLowerCase().includes(normalizedQuery) ||
    (chord !== null &&
      formatChord(chord, platform).toLowerCase().includes(normalizedQuery));

  const groups = SHORTCUT_CATEGORIES.map((category) => ({
    actions: SHORTCUT_ACTIONS.filter(
      (action) =>
        action.category === category &&
        matches(
          t(`actions.${action.id}`),
          getEffectiveBinding(action.id, overrides, platform),
        ),
    ),
    category,
  })).filter((group) => group.actions.length > 0);

  const builtIns = useMemo(
    () =>
      RESERVED_SHORTCUTS.filter((reserved) => reserved.shown).map(
        (reserved) => ({
          chords: reserved.chords[platform]
            .map(parseChord)
            .filter((chord): chord is Chord => chord !== null),
          id: reserved.id,
        }),
      ),
    [platform],
  );
  const visibleBuiltIns = builtIns.filter((builtIn) =>
    builtIn.chords.some((chord) => matches(t(`reserved.${builtIn.id}`), chord)),
  );

  const hasCustomizations = Object.keys(overrides).length > 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-base">{t("title")}</h3>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            className="w-64"
            clearLabel={t("clearSearch")}
            onValueChange={setQuery}
            placeholder={t("searchPlaceholder")}
            value={query}
          />
          <Button
            disabled={!hasCustomizations}
            onClick={() => {
              setEditingId(null);
              setSettings((previous) => ({ ...previous, keybindings: {} }));
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-4" />
            {t("resetAll")}
          </Button>
        </div>
      </div>

      {groups.map((group) => (
        <SettingsGroup
          key={group.category}
          label={t(`categories.${group.category}`)}
        >
          {group.actions.map((action) => (
            <ShortcutRow
              actionId={action.id}
              editing={editingId === action.id}
              key={action.id}
              onEdit={() => setEditingId(action.id)}
              onStopEditing={() => setEditingId(null)}
            />
          ))}
        </SettingsGroup>
      ))}

      {visibleBuiltIns.length > 0 ? (
        <SettingsGroup label={t("builtIn")}>
          {visibleBuiltIns.map((builtIn) => (
            <div className={ROW_CLASS_NAME} key={builtIn.id}>
              <span className="text-muted-foreground text-sm">
                {t(`reserved.${builtIn.id}`)}
              </span>
              <div className="flex items-center gap-3 px-2">
                {builtIn.chords.map((chord) => (
                  <ShortcutKeys
                    chord={chord}
                    key={formatChord(chord, platform)}
                  />
                ))}
              </div>
            </div>
          ))}
        </SettingsGroup>
      ) : null}

      {groups.length === 0 && visibleBuiltIns.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground text-sm">
          {t("noResults")}
        </p>
      ) : null}
    </div>
  );
};
