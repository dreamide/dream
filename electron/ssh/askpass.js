// The askpass helper ssh runs for each prompt (see askpass-server.js). It
// forwards the prompt to Dream and prints the answer; exiting non-zero
// tells ssh the user cancelled. Runs under Node or Electron-as-Node, so it
// imports nothing but Node built-ins.
import http from "node:http";

const message = process.argv.slice(2).join(" ");
const port = Number(process.env.DREAM_ASKPASS_PORT);
const secret = process.env.DREAM_ASKPASS_SECRET ?? "";

if (!port || !secret) {
  process.exit(1);
}

const request = http.request(
  {
    headers: {
      "content-type": "application/json",
      "x-dream-askpass": secret,
    },
    host: "127.0.0.1",
    method: "POST",
    path: "/",
    port,
  },
  (response) => {
    let answer = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      answer += chunk;
    });
    response.on("end", () => {
      if (response.statusCode !== 200) {
        process.exit(1);
      }
      process.stdout.write(`${answer}\n`);
      process.exit(0);
    });
  },
);
request.on("error", () => process.exit(1));
request.end(JSON.stringify({ message }));
