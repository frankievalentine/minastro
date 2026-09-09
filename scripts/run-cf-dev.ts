import { spawn } from "node:child_process";

function configuredPort(): string {
  const value = process.env.MINASTRO_CF_DEV_PORT ?? "8787";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MINASTRO_CF_DEV_PORT must be an integer between 1 and 65535; received ${value}.`);
  }
  return String(port);
}

const args = ["x", "wrangler", "dev", "--local", "--port", configuredPort()];
const persistTo = process.env.MINASTRO_CF_DEV_PERSIST_TO;
const bootstrapSecret = process.env.MINASTRO_CF_DEV_BOOTSTRAP_SECRET;
const config = process.env.MINASTRO_CF_DEV_CONFIG;
const wranglerCwd = process.env.MINASTRO_CF_DEV_WRANGLER_CWD ?? process.cwd();
const wranglerEnvironment = process.env.MINASTRO_CF_DEV_ENV;

if (persistTo) args.push("--persist-to", persistTo);
if (bootstrapSecret) args.push("--var", `EMDASH_BOOTSTRAP_SECRET:${bootstrapSecret}`);
if (config) args.push("--config", config);
if (wranglerEnvironment) args.push("--env", wranglerEnvironment);

const child = spawn(process.execPath, args, {
  cwd: wranglerCwd,
  env: process.env,
  stdio: "inherit",
});

let shuttingDown = false;
const forwardSignal = (signal: NodeJS.Signals) => {
  shuttingDown = true;
  child.kill(signal);
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("error", (error) => {
  console.error(`Could not start Wrangler local development server: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (shuttingDown) {
    process.exitCode = 0;
  } else if (signal) {
    process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  } else {
    process.exitCode = code ?? 1;
  }
});
