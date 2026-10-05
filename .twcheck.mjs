import { createRequire } from "node:module";
import fs from "node:fs";
const req = createRequire(import.meta.url);
const twPath = req.resolve("@tailwindcss/postcss");
const req2 = createRequire(twPath);
const postcss = req2("postcss");
const tw = req(twPath);
const from = "src/app/globals.css";
const r = await postcss([(tw.default ?? tw)()]).process(fs.readFileSync(from, "utf8"), { from });
const out = r.css;
for (const m of out.matchAll(/--font-(sans|inter)s*:[^;]*;/g)) console.log(m[0]);

