import { expect, test } from "vitest";
import { createIdleMonitor } from "./idle-monitor.js";

const setup = ({ timeoutMs = 1000 } = {}) => {
  let time = 0;
  let busy = false;
  let idled = 0;
  const monitor = createIdleMonitor({
    clearInterval: () => {},
    isBusy: () => busy,
    now: () => time,
    onIdle: () => {
      idled += 1;
    },
    setInterval: () => 1,
    timeoutMs,
  });
  return {
    monitor,
    advance: (ms) => {
      time += ms;
      monitor.tick();
    },
    setBusy: (value) => {
      busy = value;
    },
    idled: () => idled,
  };
};

test("shuts down after the timeout with nothing going on", () => {
  const { monitor, advance, idled } = setup();
  monitor.start();

  advance(999);
  expect(idled()).toBe(0);
  advance(1);
  expect(idled()).toBe(1);
  advance(5000);
  expect(idled()).toBe(1);
});

test("work restarts the idle clock from the first idle check", () => {
  const { monitor, advance, setBusy, idled } = setup();
  monitor.start();

  advance(900);
  setBusy(true);
  advance(10_000);
  setBusy(false);
  advance(100); // first idle check: the clock starts here
  advance(999);
  expect(idled()).toBe(0);
  advance(1);
  expect(idled()).toBe(1);
});

test("a timeout of 0 never shuts down", () => {
  const { monitor, advance, idled } = setup({ timeoutMs: 0 });
  monitor.start();

  advance(1e9);
  expect(monitor.enabled).toBe(false);
  expect(idled()).toBe(0);
});
