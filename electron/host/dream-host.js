#!/usr/bin/env node
// Entry point for the host daemon's command line (see daemon.js).
import { runDaemonCli } from "./daemon.js";

const code = await runDaemonCli(process.argv.slice(2));
process.exit(code);
