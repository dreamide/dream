import { describe, expect, it } from "vitest";
import {
  parseCursorInstallScriptVersion,
  parseGrokChannel,
  summarizeUpgradeOutput,
} from "./cli-updates.js";

describe("parseCursorInstallScriptVersion", () => {
  it("reads the pinned version from the macOS/Linux installer", () => {
    expect(
      parseCursorInstallScriptVersion(
        'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.09.26-dd393fe/linux/x64/agent-cli-package.tar.gz"',
      ),
    ).toBe("2026.09.26-dd393fe");
  });

  it("reads the pinned version from the Windows installer", () => {
    expect(
      parseCursorInstallScriptVersion(
        "$downloadUrl = 'https://downloads.cursor.com/lab/2026.09.26-dd393fe/'",
      ),
    ).toBe("2026.09.26-dd393fe");
  });

  it("returns null when the installer format changes", () => {
    expect(
      parseCursorInstallScriptVersion("<html>Not found</html>"),
    ).toBeNull();
    expect(parseCursorInstallScriptVersion(null)).toBeNull();
  });
});

describe("parseGrokChannel", () => {
  it("uses the channel printed by grok --version", () => {
    expect(parseGrokChannel("grok 1.0.41 (4220f3b224a6) [stable]")).toBe(
      "stable",
    );
    expect(parseGrokChannel("grok 1.0.42 (abc) [alpha]")).toBe("alpha");
  });

  it("falls back to stable for unknown or missing channels", () => {
    expect(parseGrokChannel("grok 1.0.41")).toBe("stable");
    expect(parseGrokChannel("grok 1.0.41 [nightly]")).toBe("stable");
    expect(parseGrokChannel(null)).toBe("stable");
  });
});

describe("summarizeUpgradeOutput", () => {
  it("strips colors and progress redraws", () => {
    expect(
      summarizeUpgradeOutput(
        "\u001b[32mDownloading\u001b[0m 50%\r100%\n",
        "\nUpdated to 2.1.283\n",
      ),
    ).toBe("Downloading 50%\n100%\nUpdated to 2.1.283");
  });

  it("keeps only the tail of long output", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const summary = summarizeUpgradeOutput(lines.join("\n"), undefined);
    expect(summary.split("\n")).toEqual(lines.slice(-12));
  });
});
