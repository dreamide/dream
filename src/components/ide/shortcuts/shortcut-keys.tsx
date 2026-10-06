import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  type Chord,
  formatChord,
  formatChordParts,
  type ShortcutActionId,
} from "@/lib/keybindings";
import { cn } from "@/lib/utils";
import { useKeyPlatform, useShortcutBinding } from "./shortcuts";

/** A chord as key caps: `⇧ ⌘ F` on macOS, `Ctrl Shift F` elsewhere. */
export const ShortcutKeys = ({
  chord,
  className,
}: {
  chord: Chord;
  className?: string;
}) => {
  const platform = useKeyPlatform();
  const parts = formatChordParts(chord, platform);
  return (
    <KbdGroup aria-label={formatChord(chord, platform)} className={className}>
      {parts.map((part, index) => (
        // Parts can repeat in theory, never in order; the index keeps keys
        // stable.
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order key caps
        <Kbd className={cn(part.length > 1 && "px-1.5")} key={index}>
          {part}
        </Kbd>
      ))}
    </KbdGroup>
  );
};

/**
 * A tooltip label with the action's current shortcut, e.g. `Back (⌘[)`.
 * Just `label` when the action has no shortcut.
 */
export const useShortcutTitle = (
  id: ShortcutActionId,
  label: string,
): string => {
  const binding = useShortcutBinding(id);
  const platform = useKeyPlatform();
  return binding ? `${label} (${formatChord(binding, platform)})` : label;
};
