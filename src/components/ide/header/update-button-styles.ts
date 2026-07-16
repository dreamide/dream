import type { UpdateState } from "@/types/ide";

type UpdateButtonVariant = "accent" | "destructive" | "ghost";

export const UPDATE_BUTTON_VARIANT_BY_STATE = {
  idle: "ghost",
  disabled: "ghost",
  checking: "ghost",
  available: "ghost",
  downloading: "ghost",
  downloaded: "accent",
  "not-available": "ghost",
  error: "destructive",
} as const satisfies Record<UpdateState, UpdateButtonVariant>;
