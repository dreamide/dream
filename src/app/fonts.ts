// Bundled CJK fallbacks for Inter and JetBrains Mono (font stacks in index.html).
// Each face is split into unicode-range chunks, so only the glyphs a page uses
// are loaded. Imported from JS rather than globals.css because Tailwind's
// PostCSS @import inlining does not rebase the @font-face url()s.
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-sans-tc";
import "@fontsource-variable/noto-sans-jp";
import "@fontsource-variable/noto-sans-kr";
