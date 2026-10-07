import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppScreenshotToast } from "@/components/ide/app-screenshot-toast";
import { DiffPlaceholder } from "@/components/ide/diff-placeholder";
import { IdeDiffViewer } from "@/components/ide/diff-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import messages from "@/i18n/messages/en.json";
import { DIFF_CASES } from "./diff-cases";
import { fixtureDesktop } from "./fixture-bridge";

// Returns each side's actual row geometry, including Pierre's shadow DOM.
const geometry = (container: Element) => {
  const surface = container.querySelector(".dream-diff-viewer");
  if (!surface) return null;
  const root =
    surface.shadowRoot ??
    surface.querySelector("diffs-container")?.shadowRoot ??
    surface;
  const top = surface.getBoundingClientRect().top;
  return {
    height: surface.getBoundingClientRect().height,
    rows: [
      ...root.querySelectorAll(
        '[data-line], [data-kind]:not([data-kind="empty"]), [data-no-newline][data-column-content]',
      ),
    ]
      .map((line) => ({
        top: line.getBoundingClientRect().top - top,
        left:
          line.getBoundingClientRect().left -
          surface.getBoundingClientRect().left,
        height: line.getBoundingClientRect().height,
        text: line.textContent,
      }))
      .sort((a, b) => a.top - b.top || a.left - b.left),
  };
};

const DelayedDiff = ({
  diff,
  mode,
  wrap,
  delay,
}: {
  diff: (typeof DIFF_CASES)[string];
  mode: "unified" | "split";
  wrap: boolean;
  delay: number;
}) => {
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHighlight(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return highlight ? (
    <IdeDiffViewer fileDiff={diff} diffStyle={mode} wordWrap={wrap} />
  ) : (
    <div className="dream-diff-surface">
      <DiffPlaceholder fileDiff={diff} diffStyle={mode} wordWrap={wrap} />
    </div>
  );
};

const Fixtures = () => {
  const params = new URLSearchParams(location.search);
  const [theme, setTheme] = useState(
    params.get("theme") === "light" ? "light" : "dark",
  );
  const [example, setExample] = useState(
    params.get("case") && DIFF_CASES[params.get("case") ?? ""]
      ? (params.get("case") ?? "modified")
      : "modified",
  );
  const [mode, setMode] = useState<"unified" | "split">(
    params.get("mode") === "split" ? "split" : "unified",
  );
  const [wrap, setWrap] = useState(params.get("wrap") === "1");
  const [delay, setDelay] = useState(
    Math.min(10000, Math.max(0, Number(params.get("delay") ?? 1000) || 0)),
  );
  const [revision, setRevision] = useState(0);
  const [measurements, setMeasurements] = useState<unknown>(null);
  const plain = useRef<HTMLDivElement>(null);
  const finished = useRef<HTMLDivElement>(null);
  const diff = DIFF_CASES[example];
  const measure = (display = false) => {
    const placeholder = plain.current && geometry(plain.current);
    const highlighted = finished.current && geometry(finished.current);
    const ready = Boolean(finished.current?.querySelector("diffs-container"));
    const result = {
      case: example,
      mode,
      wrap,
      theme,
      placeholder,
      highlighted,
      ready,
      comparison:
        !ready || !placeholder || !highlighted
          ? "pending"
          : Math.abs(placeholder.height - highlighted.height) <= 1 &&
              placeholder.rows.length === highlighted.rows.length &&
              placeholder.rows.every(
                (row, i) =>
                  Math.abs(row.top - highlighted.rows[i].top) <= 1 &&
                  Math.abs(row.height - highlighted.rows[i].height) <= 1,
              )
            ? "matched"
            : "layout mismatch",
      desktopCalls: fixtureDesktop.calls,
    };
    if (display) setMeasurements(result);
    return result;
  };
  useEffect(() => {
    Object.defineProperty(window, "__dreamFixtures", {
      configurable: true,
      value: {
        measure,
        screenshot: fixtureDesktop.screenshot,
        configure: (options: {
          example: string;
          mode: "unified" | "split";
          wrap: boolean;
          theme: "light" | "dark";
        }) => {
          if (!DIFF_CASES[options.example])
            throw new Error("Unknown diff case");
          setExample(options.example);
          setMode(options.mode);
          setWrap(options.wrap);
          setTheme(options.theme);
          setDelay(0);
          setRevision((current) => current + 1);
        },
      },
    });
    return () => {
      Reflect.deleteProperty(window, "__dreamFixtures");
    };
  });
  return (
    <ThemeProvider
      attribute="class"
      forcedTheme={theme}
      enableSystem={false}
      disableTransitionOnChange
      storageKey="dream-fixture-theme"
    >
      <main className="min-h-screen bg-background p-6 text-foreground">
        <h1 className="mb-2 text-2xl font-semibold">UI fixtures</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Development preview. Desktop actions stay in memory; live API calls
          are blocked.
        </p>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Select
            value={example}
            onValueChange={(value) => {
              if (value) setExample(value);
            }}
          >
            <SelectTrigger aria-label="Diff case">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(DIFF_CASES).map((key) => (
                <SelectItem key={key} value={key}>
                  {key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() => setMode(mode === "unified" ? "split" : "unified")}
          >
            {mode}
          </Button>
          <Button variant="outline" onClick={() => setWrap(!wrap)}>
            Wrap: {wrap ? "on" : "off"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme}
          </Button>
          <label className="text-sm">
            Highlight delay (ms){" "}
            <input
              className="w-24 rounded border px-2 py-1"
              type="number"
              min="0"
              max="10000"
              value={delay}
              onChange={(event) =>
                setDelay(
                  Math.min(10000, Math.max(0, Number(event.target.value))),
                )
              }
            />
          </label>
          <Button onClick={() => setRevision(revision + 1)}>Replay</Button>
          <Button variant="outline" onClick={() => measure(true)}>
            Measure rows
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 font-medium">Placeholder reference</h2>
            <div
              ref={plain}
              className="dream-diff-surface min-w-0 overflow-hidden rounded border"
            >
              <DiffPlaceholder
                fileDiff={diff}
                diffStyle={mode}
                wordWrap={wrap}
              />
            </div>
          </section>
          <section>
            <h2 className="mb-2 font-medium">Delayed highlighting</h2>
            <div
              ref={finished}
              className="min-w-0 overflow-hidden rounded border"
            >
              <DelayedDiff
                key={`${example}-${mode}-${wrap}-${theme}-${delay}-${revision}`}
                diff={diff}
                mode={mode}
                wrap={wrap}
                delay={delay}
              />
            </div>
          </section>
        </div>
        <div className="mt-6 flex items-center gap-4">
          <Badge variant="outline">stdio</Badge>
          <Badge variant="outline">http</Badge>
          <Button size="sm" onClick={fixtureDesktop.screenshot}>
            Screenshot toast
          </Button>
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>
              Example dialog
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add server</DialogTitle>
                <DialogDescription>
                  Inspect focus, dismissal, and theme styles.
                </DialogDescription>
              </DialogHeader>
              <Button size="sm">Add</Button>
            </DialogContent>
          </Dialog>
        </div>
        {measurements !== null && (
          <pre className="mt-6 max-h-80 overflow-auto rounded border p-3 text-xs">
            {JSON.stringify(measurements, null, 2)}
          </pre>
        )}
        <AppScreenshotToast />
        <Toaster />
      </main>
    </ThemeProvider>
  );
};

export const mountFixtures = () => {
  const element = document.getElementById("root");
  if (!element) throw new Error("Fixture root not found");
  createRoot(element).render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <Fixtures />
    </NextIntlClientProvider>,
  );
};
