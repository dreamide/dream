import { describe, expect, it } from "vitest";
import { extractCliVersion, isCliUpdateAvailable } from "./cli-version";

describe("extractCliVersion", () => {
  it("pulls the version out of each CLI's --version output", () => {
    expect(extractCliVersion("2.1.282 (Claude Code)")).toBe("2.1.282");
    expect(extractCliVersion("codex-cli 0.156.1")).toBe("0.156.1");
    expect(extractCliVersion("1.18.32")).toBe("1.18.32");
    expect(extractCliVersion("grok 1.0.41 (4220f3b224a6) [stable]")).toBe(
      "1.0.41",
    );
    expect(extractCliVersion("2026.09.26-dd393fe")).toBe("2026.09.26-dd393fe");
  });

  it("returns null for missing output and the raw text when unparseable", () => {
    expect(extractCliVersion(null)).toBeNull();
    expect(extractCliVersion("")).toBeNull();
    expect(extractCliVersion("dev build")).toBe("dev build");
  });
});

describe("isCliUpdateAvailable", () => {
  it("flags a newer release", () => {
    expect(isCliUpdateAvailable("2.1.282 (Claude Code)", "2.1.283")).toBe(true);
    expect(isCliUpdateAvailable("codex-cli 0.156.1", "0.157.1")).toBe(true);
    expect(isCliUpdateAvailable("1.9.0", "1.10.0")).toBe(true);
    expect(isCliUpdateAvailable("1.0", "1.0.1")).toBe(true);
  });

  it("does not flag the same or an older release", () => {
    expect(isCliUpdateAvailable("1.18.32", "1.18.32")).toBe(false);
    expect(isCliUpdateAvailable("0.159.0-alpha.8", "0.157.1")).toBe(false);
    expect(isCliUpdateAvailable("grok 1.0.42 (abc123) [alpha]", "1.0.41")).toBe(
      false,
    );
  });

  it("compares Cursor's date-based versions", () => {
    expect(
      isCliUpdateAvailable("2026.09.18-7ae6800", "2026.09.26-dd393fe"),
    ).toBe(true);
    expect(
      isCliUpdateAvailable("2026.09.26-dd393fe", "2026.09.26-dd393fe"),
    ).toBe(false);
  });

  it("treats a prerelease as older than its release", () => {
    expect(isCliUpdateAvailable("1.2.0-beta.1", "1.2.0")).toBe(true);
    expect(isCliUpdateAvailable("1.2.0", "1.2.0-beta.1")).toBe(false);
  });

  it("does not flag anything when either version is unknown", () => {
    expect(isCliUpdateAvailable(null, "1.0.0")).toBe(false);
    expect(isCliUpdateAvailable("1.0.0", null)).toBe(false);
    expect(isCliUpdateAvailable("dev build", "1.0.0")).toBe(false);
  });
});
