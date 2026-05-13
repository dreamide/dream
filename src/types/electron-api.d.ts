import type { DesktopApi } from "@/types/ide";

declare global {
  interface Window {
    dream?: DesktopApi;
  }
}
