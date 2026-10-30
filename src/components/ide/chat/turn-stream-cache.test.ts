import { describe, expect, it } from "vitest";
import {
  createTurnStreamCache,
  TURN_ID_HEADER,
  TURN_OFFSET_HEADER,
  TurnStreamMismatchError,
} from "./turn-stream-cache";

const encoder = new TextEncoder();
/** Lets a reader take what was written before the stream breaks. */
const drained = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A turn stream the test writes, ends or breaks. */
const turnResponse = (turnId: string | null, offset = 0) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
  };
  if (turnId) {
    headers[TURN_ID_HEADER] = turnId;
    headers[TURN_OFFSET_HEADER] = String(offset);
  }
  return {
    response: new Response(body, { headers }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: () => controller.error(new TypeError("network lost")),
  };
};

/** Reads `response` until it ends or fails; resolves with what it read. */
const readAll = async (response: Response) => {
  if (!response.body) throw new Error("No body to read.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { failed: false, text };
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { failed: true, text };
  }
};

describe("the turn stream cache", () => {
  it("resumes from the bytes it kept and replays the whole turn", async () => {
    const cache = createTurnStreamCache();
    const first = turnResponse("t1");
    const read = readAll(cache.read("c1", first.response, null));
    first.write("data: one\n\n");
    first.write("data: tw");
    await drained();
    first.fail();
    expect(await read).toEqual({
      failed: true,
      text: "data: one\n\ndata: tw",
    });

    const resume = cache.cursor("c1");
    expect(resume).toMatchObject({ length: 19, turnId: "t1" });
    expect(cache.resumeUrl("/api/chat/c1/stream", resume)).toBe(
      "/api/chat/c1/stream?turn=t1&from=19",
    );
    expect(
      cache.resumeUrl("https://host.example/api/chat/c1/stream", resume),
    ).toBe("https://host.example/api/chat/c1/stream?turn=t1&from=19");

    const tail = turnResponse("t1", 19);
    const resumed = readAll(cache.read("c1", tail.response, resume));
    tail.write("o\n\n");
    tail.end();
    expect(await resumed).toEqual({
      failed: false,
      text: "data: one\n\ndata: two\n\n",
    });
    // Ended: nothing left to resume.
    expect(cache.cursor("c1")).toBeNull();
  });

  it("starts over for a whole replay or another turn", async () => {
    const cache = createTurnStreamCache();
    const first = turnResponse("t1");
    const read = readAll(cache.read("c1", first.response, null));
    first.write("abc");
    await drained();
    first.fail();
    await read;
    const resume = cache.cursor("c1");

    const replay = turnResponse("t2", 0);
    const replayed = readAll(cache.read("c1", replay.response, resume));
    replay.write("xyz");
    replay.end();
    expect((await replayed).text).toBe("xyz");
  });

  it("refuses a tail it cannot complete", () => {
    const cache = createTurnStreamCache();
    const stray = turnResponse("t1", 5);
    expect(() => cache.read("c1", stray.response, null)).toThrow(
      TurnStreamMismatchError,
    );
  });

  it("forgets a turn when the host says none runs, or names no turn", async () => {
    const cache = createTurnStreamCache();
    const first = turnResponse("t1");
    const read = readAll(cache.read("c1", first.response, null));
    first.write("abc");
    await drained();
    first.fail();
    await read;
    expect(cache.keptLength("c1")).toBe(3);
    cache.read("c1", new Response(null, { status: 204 }), null);
    expect(cache.keptLength("c1")).toBe(0);

    const older = turnResponse(null);
    const passed = cache.read("c1", older.response, null);
    expect(passed).toBe(older.response);
  });
});
