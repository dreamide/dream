/**
 * A host socket client over a fake transport, for tests: the sockets it
 * opens, the timers it schedules and the ticket route are all in reach.
 */
import { vi } from "vitest";
import {
  createHostSocketClient,
  type HostSocketTransport,
} from "./host-socket";

export class FakeTransport implements HostSocketTransport {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: HostSocketTransport["onopen"] = null;
  onmessage: HostSocketTransport["onmessage"] = null;
  onclose: HostSocketTransport["onclose"] = null;
  onerror: HostSocketTransport["onerror"] = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

export const createFakeHostSocket = () => {
  const transports: FakeTransport[] = [];
  const timers: Array<() => void> = [];
  const api = { hostSocketTicket: vi.fn(async () => ({ ticket: "t" })) };
  const socket = createHostSocketClient({
    api,
    clearTimer: () => {},
    openSocket: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  });
  /** Lets the ticket request resolve and the transport be created. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { api, flush, socket, timers, transports };
};
