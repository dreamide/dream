import type { DreamDesktopApi } from "@/types/ide";

declare global {
  interface Window {
    dream?: DreamDesktopApi;
  }
}
