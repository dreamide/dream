import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: pnpm architecture:report <document.md> [output.html]",
  );
const escapeHtml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
let inCode = false;
const body = (await readFile(source, "utf8"))
  .split(/\r?\n/)
  .map((line) => {
    if (line.startsWith("```")) {
      inCode = !inCode;
      return inCode ? "<pre><code>" : "</code></pre>";
    }
    if (inCode) return `${escapeHtml(line)}\n`;
    const heading = line.match(/^(#{1,6}) (.+)$/);
    if (heading)
      return `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`;
    return line
      ? `<p>${escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`
      : "";
  })
  .join("\n");
const output = path.resolve(
  process.argv[3] ??
    path.join(
      os.tmpdir(),
      "dream-reports",
      `${path.basename(source, ".md")}.html`,
    ),
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(path.basename(source))}</title><style>body{max-width:900px;margin:40px auto;padding:0 24px;font:16px/1.5 system-ui;color:#18181b;background:#fafafa}h2{margin-top:40px;border-top:1px solid #d4d4d8;padding-top:16px}p{margin:5px 0}code{font-size:14px;background:#e4e4e7;padding:2px 4px;border-radius:3px}pre{white-space:pre-wrap;padding:16px;background:#e4e4e7}</style><body><p>Source: ${escapeHtml(path.resolve(source))}. Generated view; edit the Markdown document.</p>${body}</body></html>`,
  "utf8",
);
console.log(output);
