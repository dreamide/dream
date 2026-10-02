import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";
import StreamingMarkdownBlock from "./streaming-markdown-block";
import {
  getStreamingTailAnimationStartOffset,
  STREAMING_BACKLOG_FULL_SPEED_CHARS,
  STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
  StreamingMarkdownBlockContext,
} from "./streaming-message";

const MESSAGE = `**In t3code, desktop and phone see the same chats** because they're both clients of one server.

- **Storage:** each machine running T3 Code has one server that owns everything in its own SQLite database (\`state.sqlite\`, now \`statev2.sqlite\`). It's event-sourced: every change is appended to an event log.
- **The desktop app** runs that server locally and is just one client of it.
- **Phone, browser or another computer** connect to that same server over an authenticated WebSocket.
- **Several machines** mean several servers, each with its own database. A client can add several "environments" and switch between them.

**Dream already works the same way:**

- Each host owns its projects, chats and transcripts in its own SQLite database (\`dream.db\`, or \`dev.db\` for your dev build). For an SSH host it's \`~/.dream/host/data/dream.db\` on that server.
- \`dream.db\` vs \`dev.db\` is exactly t3code's "two environments": two separate local hosts with separate chats.

**Differences:**

> **No event sourcing in Dream.** Dream writes chats and projects directly as rows, and keeps only a short, temporary log so reconnecting clients can catch up.
>
> **No way in for a phone.** Dream's hosts only accept the desktop app: they listen on \`localhost\`, with a token held by the app.

So if you ever build the phone companion, the chats question is already solved.
`;

// Uneven deltas, like a provider stream: single characters, words, and runs
// that cross block boundaries.
const DELTA_SIZES = [7, 23, 41, 3, 60, 15, 1, 88, 12, 30, 5, 120, 9];

const ANIMATED_TOKEN_PATTERN =
  /<(span|code)[^>]*data-sd-animate[^>]*>([\s\S]*?)<\/\1>/g;

// Streamdown pads a trailing lone list marker with a zero-width space so the
// empty bullet renders; that padding is not part of the markdown text.
const decodeEntities = (value: string) =>
  value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/​|‌|‍|﻿/g, "");

const getAnimatedTexts = (html: string) =>
  Array.from(html.matchAll(ANIMATED_TOKEN_PATTERN), (match) =>
    decodeEntities((match[2] ?? "").replace(/<[^>]+>/g, "")),
  );

const renderFrame = (markdownText: string, animationStartOffset: number) =>
  renderToStaticMarkup(
    createElement(
      StreamingMarkdownBlockContext.Provider,
      {
        value: {
          animateStreamedText: true,
          markdownAnimationStartOffset: animationStartOffset,
          markdownText,
        },
      },
      createElement(
        Streamdown,
        {
          BlockComponent: StreamingMarkdownBlock,
          isAnimating: true,
          plugins: streamdownPlugins,
        },
        markdownText,
      ),
    ),
  );

// Mirrors StreamingMessageResponse: a delta animates its last few tokens, and
// a very large delta is flushed without animation.
const getFrameAnimationStartOffset = (currentText: string, nextText: string) =>
  nextText.length - currentText.length < STREAMING_BACKLOG_FULL_SPEED_CHARS
    ? getStreamingTailAnimationStartOffset({
        currentText,
        holdIncompleteInlineCode: true,
        maxAnimatedTokens: STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
        nextText,
      })
    : nextText.length;

// Every animated token must appear, in order, inside the streamed tail. Text
// before the tail has already settled and must render without animation. An
// inline code span is atomic, so one that starts before the tail and ends
// inside it is animated whole: accept a token whose suffix opens the tail.
const findTokensOutsideTail = (animatedTexts: string[], tail: string) => {
  let cursor = 0;

  return animatedTexts.filter((text) => {
    const token = text.trim();
    if (!token) {
      return false;
    }

    const index = tail.indexOf(token, cursor);
    if (index !== -1) {
      cursor = index + token.length;
      return false;
    }

    for (let start = 1; start < token.length; start++) {
      if (tail.startsWith(token.slice(start), cursor)) {
        cursor += token.length - start;
        return false;
      }
    }

    return true;
  });
};

describe("StreamingMarkdownBlock", () => {
  it("animates only the streamed tail of each frame, in every block", () => {
    let currentText = "";
    let deltaIndex = 0;
    let animatedFrames = 0;

    while (currentText.length < MESSAGE.length) {
      const deltaSize = DELTA_SIZES[deltaIndex++ % DELTA_SIZES.length] ?? 1;
      const nextText = MESSAGE.slice(0, currentText.length + deltaSize);
      const animationStartOffset = getFrameAnimationStartOffset(
        currentText,
        nextText,
      );
      const animatedTexts = getAnimatedTexts(
        renderFrame(nextText, animationStartOffset),
      );
      const tail = nextText.slice(animationStartOffset);

      expect(
        findTokensOutsideTail(animatedTexts, tail),
        `frame ending at ${nextText.length} animated text outside its tail ${JSON.stringify(tail)}`,
      ).toEqual([]);

      if (animatedTexts.length > 0) {
        animatedFrames++;
      }
      currentText = nextText;
    }

    expect(animatedFrames).toBeGreaterThan(0);
  });

  it("does not reuse an earlier block's animation offset for later blocks", () => {
    const settled = "A paragraph that has already streamed in full.\n\n";
    const next = `${settled}- bullet one\n- bullet two`;

    // Streamdown caches unified processors across renders. The first frame
    // animates everything from offset zero; the second frame must still only
    // animate its own tail.
    renderFrame(settled, 0);
    const html = renderFrame(next, next.length - "two".length);

    expect(getAnimatedTexts(html)).toEqual(["two"]);
    expect(html).not.toContain("data-dream-streaming-list-item-animate");
  });
});
