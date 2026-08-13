import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpConnection } from "./acp-transport.js";

const createChild = () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ACP transport cleanup", () => {
  it("escalates to SIGKILL when a child ignores SIGTERM", () => {
    vi.useFakeTimers();
    const child = createChild();
    const connection = new AcpConnection(child, "Test");

    connection.close();
    expect(child.kill).toHaveBeenCalledWith();

    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("cancels escalation after the child exits", () => {
    vi.useFakeTimers();
    const child = createChild();
    const connection = new AcpConnection(child, "Test");

    connection.close();
    child.emit("exit", 0);
    vi.advanceTimersByTime(2_000);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
