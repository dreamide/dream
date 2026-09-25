/**
 * JavaScript injected into browser guest pages by the agent browser tools.
 *
 * Everything here runs inside the guest's main world via
 * `webContents.executeJavaScript`, so it must be self-contained. Element
 * references produced by the snapshot live on `window.__dreamAgentRefs` and
 * survive until the page navigates.
 */

export const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000;

/**
 * Produces a compact, indented outline of the visible page: one line per
 * meaningful element with a stable `ref` the model can pass back to
 * click/type tools.
 */
export const buildSnapshotScript = ({
  maxChars = DEFAULT_SNAPSHOT_MAX_CHARS,
  selector = null,
} = {}) => `(() => {
  const MAX_CHARS = ${JSON.stringify(Number(maxChars) || DEFAULT_SNAPSHOT_MAX_CHARS)};
  const ROOT_SELECTOR = ${JSON.stringify(selector)};
  const refs = new Map();
  window.__dreamAgentRefs = refs;
  let nextRef = 1;

  const INTERACTIVE_TAGS = new Set(["a","button","input","select","textarea","summary","option","label"]);
  const SKIP_TAGS = new Set(["script","style","noscript","template","head","meta","link","title","svg","path","br","hr"]);
  const HEADING = /^h[1-6]$/;

  const clip = (text, max = 90) => {
    const value = String(text ?? "").replace(/\\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  };

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.getAttribute("aria-hidden") === "true" || el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "label") return "label";
    if (tag === "li") return "listitem";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "dialog") return "dialog";
    if (HEADING.test(tag)) return "heading";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "range") return "slider";
      if (type === "hidden") return null;
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0" || getComputedStyle(el).cursor === "pointer") return "clickable";
    return "generic";
  };

  const isInteractive = (el, role) =>
    INTERACTIVE_TAGS.has(el.tagName.toLowerCase()) ||
    el.isContentEditable ||
    ["button","link","textbox","checkbox","radio","combobox","option","slider","tab","menuitem","switch","clickable"].includes(role);

  const directText = (el) => {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return clip(text);
  };

  const nameOf = (el, role) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "");
      const joined = clip(parts.join(" "));
      if (joined) return joined;
    }
    if (el.tagName === "IMG") return clip(el.getAttribute("alt") || el.getAttribute("title") || "");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return clip(label.textContent);
      }
      const wrapping = el.closest("label");
      if (wrapping) return clip(wrapping.textContent);
      return clip(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "");
    }
    if (isInteractive(el, role) || role === "heading") return clip(el.textContent);
    return directText(el);
  };

  const attrsOf = (el, role) => {
    const attrs = [];
    const tag = el.tagName.toLowerCase();
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href) attrs.push("href=" + JSON.stringify(clip(href, 120)));
    }
    if (role === "heading") {
      const level = el.getAttribute("aria-level") || (HEADING.test(tag) ? tag.slice(1) : null);
      if (level) attrs.push("level=" + level);
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = el.getAttribute("type");
      if (type && tag === "input") attrs.push("type=" + type);
      if (el.value && type !== "password") attrs.push("value=" + JSON.stringify(clip(el.value, 60)));
      if (el.placeholder) attrs.push("placeholder=" + JSON.stringify(clip(el.placeholder, 60)));
      if (el.checked) attrs.push("checked");
      if (el.required) attrs.push("required");
    }
    if (el.isContentEditable && el.textContent) attrs.push("value=" + JSON.stringify(clip(el.textContent, 60)));
    if (el.disabled || el.getAttribute("aria-disabled") === "true") attrs.push("disabled");
    if (el.getAttribute("aria-expanded")) attrs.push("expanded=" + el.getAttribute("aria-expanded"));
    if (el.getAttribute("aria-selected") === "true" || el.selected) attrs.push("selected");
    if (el.getAttribute("aria-current")) attrs.push("current");
    if (document.activeElement === el) attrs.push("focused");
    return attrs;
  };

  const lines = [];
  let truncated = false;
  let total = 0;
  const push = (line) => {
    if (truncated) return;
    if (total + line.length + 1 > MAX_CHARS) {
      truncated = true;
      return;
    }
    total += line.length + 1;
    lines.push(line);
  };

  const walk = (el, depth) => {
    if (truncated || !(el instanceof Element)) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (!isVisible(el)) return;

    const role = roleOf(el);
    if (role === null) return;
    const interactive = isInteractive(el, role);
    const name = nameOf(el, role);
    const emit = interactive || role === "heading" || role === "img" || (role !== "generic" && name) || (role === "generic" && directText(el));

    let childDepth = depth;
    if (emit) {
      const ref = "e" + nextRef++;
      refs.set(ref, el);
      const parts = ["  ".repeat(Math.min(depth, 12)) + "[" + ref + "] " + role];
      if (name) parts.push(JSON.stringify(name));
      const attrs = attrsOf(el, role);
      if (attrs.length) parts.push(attrs.join(" "));
      push(parts.join(" "));
      childDepth = depth + 1;
    }

    // Interactive leaves already expose their text; skip descending into them.
    if (interactive && tag !== "form" && role !== "label") return;
    for (const child of el.children) walk(child, childDepth);
  };

  const root = ROOT_SELECTOR ? document.querySelector(ROOT_SELECTOR) : document.body;
  if (!root) {
    return { error: "No element matches selector " + JSON.stringify(ROOT_SELECTOR) };
  }
  walk(root, 0);

  return {
    lines,
    refCount: nextRef - 1,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
    title: document.title,
    truncated,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
  };
})()`;

/**
 * Shared element lookup used by click/type/scroll scripts. Accepts either a
 * snapshot ref ("e12") or a CSS selector.
 */
const buildLocatorSnippet = ({ ref = null, selector = null }) => `
  const target = (() => {
    const ref = ${JSON.stringify(ref)};
    const selector = ${JSON.stringify(selector)};
    if (ref) {
      const el = window.__dreamAgentRefs && window.__dreamAgentRefs.get(ref);
      if (!el) return { error: "Unknown ref " + JSON.stringify(ref) + ". Take a new browser_snapshot; refs reset on navigation." };
      if (!el.isConnected) return { error: "Element for ref " + JSON.stringify(ref) + " is no longer in the document. Take a new browser_snapshot." };
      return { el };
    }
    if (selector) {
      let el = null;
      try { el = document.querySelector(selector); } catch (error) { return { error: "Invalid selector: " + error.message }; }
      if (!el) return { error: "No element matches selector " + JSON.stringify(selector) };
      return { el };
    }
    return { error: "Provide either ref or selector." };
  })();
  if (target.error) return { error: target.error };
  const el = target.el;
`;

const describeSnippet = `
  const describe = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      tag: node.tagName.toLowerCase(),
      text: String(node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
`;

/**
 * Scrolls the element into view and returns the viewport coordinates of its
 * centre so the main process can dispatch real mouse events there. Reports
 * whether another element is covering that point.
 */
export const buildLocateForPointerScript = (locator) => `(() => {
  ${buildLocatorSnippet(locator)}
  ${describeSnippet}
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const inViewport = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  const hit = inViewport ? document.elementFromPoint(x, y) : null;
  const covered = Boolean(hit) && hit !== el && !el.contains(hit) && !hit.contains(el);
  return {
    covered,
    coveredBy: covered ? describe(hit) : null,
    element: describe(el),
    inViewport,
    x,
    y,
  };
})()`;

/**
 * Fallback click when pointer events cannot be used (element covered or
 * off-screen): focuses and invokes the element's own click handler.
 */
export const buildProgrammaticClickScript = (locator) => `(() => {
  ${buildLocatorSnippet(locator)}
  ${describeSnippet}
  if (typeof el.focus === "function") el.focus();
  el.click();
  return { element: describe(el), method: "element.click()" };
})()`;

/**
 * Focuses an editable element (optionally clearing it) so subsequent
 * keyboard events land in it.
 */
export const buildFocusForTypingScript = (
  locator,
  { clear = false } = {},
) => `(() => {
  ${buildLocatorSnippet(locator)}
  ${describeSnippet}
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (typeof el.focus === "function") el.focus();
  const editable = el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
  if (${JSON.stringify(Boolean(clear))} && editable) {
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (typeof el.select === "function") {
      el.select();
    }
  }
  return { editable, element: describe(el), focused: document.activeElement === el };
})()`;

export const buildSelectOptionScript = (locator, values) => `(() => {
  ${buildLocatorSnippet(locator)}
  ${describeSnippet}
  if (el.tagName !== "SELECT") return { error: "Element is not a <select>." };
  const wanted = ${JSON.stringify(values)};
  const matched = [];
  for (const option of el.options) {
    const hit = wanted.includes(option.value) || wanted.includes(option.textContent.trim());
    option.selected = hit;
    if (hit) matched.push(option.value);
    if (hit && !el.multiple) break;
  }
  if (!matched.length) return { error: "No option matched " + JSON.stringify(wanted) + ". Available: " + Array.from(el.options).map((o) => o.textContent.trim() || o.value).join(", ") };
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { element: describe(el), selected: matched };
})()`;

export const buildScrollScript = ({
  deltaX = 0,
  deltaY = 0,
  ref = null,
  selector = null,
}) => `(() => {
  ${ref || selector ? buildLocatorSnippet({ ref, selector }) : "const el = null;"}
  if (el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }
  if (${JSON.stringify(Number(deltaX) || 0)} || ${JSON.stringify(Number(deltaY) || 0)}) {
    const scroller = el && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) ? el : window;
    scroller.scrollBy({ left: ${JSON.stringify(Number(deltaX) || 0)}, top: ${JSON.stringify(Number(deltaY) || 0)}, behavior: "instant" });
  }
  return { scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewportHeight: innerHeight } };
})()`;

export const buildWaitForScript = ({
  selector = null,
  text = null,
  urlIncludes = null,
}) => `(() => {
  const selector = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  const urlIncludes = ${JSON.stringify(urlIncludes)};
  if (urlIncludes && !location.href.includes(urlIncludes)) return { ready: false, reason: "url" };
  if (selector) {
    let el = null;
    try { el = document.querySelector(selector); } catch (error) { return { error: "Invalid selector: " + error.message }; }
    if (!el) return { ready: false, reason: "selector" };
  }
  if (text && !(document.body && document.body.innerText.includes(text))) return { ready: false, reason: "text" };
  return { ready: true, url: location.href, title: document.title };
})()`;

/**
 * Expression (for CDP `Runtime.evaluate`) that yields the element for a
 * locator, so `DOM.setFileInputFiles` can target it by remote object id.
 */
export const buildFileInputLookupExpression = ({
  ref = null,
  selector = null,
}) => `(() => {
  const ref = ${JSON.stringify(ref)};
  const selector = ${JSON.stringify(selector)};
  const el = ref
    ? (window.__dreamAgentRefs && window.__dreamAgentRefs.get(ref)) || null
    : selector
      ? document.querySelector(selector)
      : null;
  if (!el) throw new Error("File input not found for " + JSON.stringify(ref || selector));
  return el;
})()`;

/**
 * Wraps a user expression so its result is JSON-safe and errors are reported
 * instead of thrown. Async expressions (promises) are awaited.
 */
export const buildEvaluateScript = (expression) => `(async () => {
  const safe = (value, depth = 0) => {
    if (value === undefined) return null;
    if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
    if (value instanceof Error) return { error: value.message, name: value.name, stack: value.stack };
    if (value instanceof Element) return { tag: value.tagName.toLowerCase(), id: value.id || undefined, className: value.className || undefined, text: String(value.textContent || "").trim().slice(0, 200) };
    if (value instanceof Node) return "[node " + value.nodeName + "]";
    if (depth > 6) return "[nested]";
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => safe(item, depth + 1));
    if (typeof value === "object") {
      const out = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count++ >= 100) { out.__truncated = true; break; }
        try { out[key] = safe(value[key], depth + 1); } catch (error) { out[key] = "[unreadable]"; }
      }
      return out;
    }
    return String(value);
  };
  try {
    const result = await (0, eval)(${JSON.stringify(String(expression))});
    return { ok: true, result: safe(result) };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error), stack: error && error.stack ? String(error.stack).slice(0, 2000) : undefined };
  }
})()`;
