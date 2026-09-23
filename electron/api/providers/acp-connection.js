import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 64_000;

export class AcpConnection {
  constructor(child, label = "Agent") {
    this.label = label;
    this.child = child;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.onNotification = null;
    this.onRequest = null;
    this.reader = readline.createInterface({ input: child.stdout });

    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(
        -MAX_STDERR_CHARS,
      );
    });
    child.on("error", (error) => this.failPending(error));
    child.on("close", (code) => {
      this.closed = true;
      this.reader.close();
      const detail = this.stderr.trim();
      this.failPending(
        new Error(
          detail ||
            (code === 0
              ? `${this.label} ACP connection closed.`
              : `${this.label} CLI exited with code ${code}.`),
        ),
      );
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ||
              message.error.data?.message ||
              JSON.stringify(message.error),
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.handleIncomingRequest(message);
      return;
    }

    if (message.method) {
      this.onNotification?.(message.method, message.params ?? {});
    }
  }

  async handleIncomingRequest(message) {
    try {
      if (!this.onRequest) {
        throw new Error(
          `Unsupported ${this.label} ACP request: ${message.method}`,
        );
      }
      const result = await this.onRequest(message.method, message.params ?? {});
      this.write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message:
            error instanceof Error
              ? error.message
              : `${this.label} ACP request failed.`,
        },
      });
    }
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(
        new Error(`${this.label} ACP connection is closed.`),
      );
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ACP ${method} request timed out.`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.failPending(new Error(`${this.label} ACP connection closed.`));
    this.child.kill();
  }
}
