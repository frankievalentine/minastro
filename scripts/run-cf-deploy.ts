import { spawn } from "node:child_process";
import { createTerminalUI } from "./terminal-ui";

const ui = createTerminalUI();
ui.section("Cloudflare deployment");
ui.note("Deploying configured Worker (full Wrangler output follows)");

const child = spawn(process.execPath, ["x", "wrangler", "deploy"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  ui.failure(`Could not start Wrangler deployment: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  else process.exitCode = code ?? 1;
  if (process.exitCode === 0) ui.success("Worker deployment complete");
});
