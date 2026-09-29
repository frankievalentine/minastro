import { createTerminalUI } from "./terminal-ui";

const ui = createTerminalUI();
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

ui.section("Cloudflare setup preview");
ui.note("Simulated progress only. No Cloudflare requests, secrets, or deployments.");

ui.section("Cloudflare account");
await ui.run("Verifying account access (simulated)", () => pause(700));

ui.section("Plan and approval");
ui.note("Worker: my-site (example only)");
ui.note("Custom domain: https://example.com (example only)");
ui.note("Approval prompts are skipped in this preview.");

ui.section("Cloudflare resources");
for (const label of ["Checking D1 databases", "Checking R2 buckets", "Checking KV namespaces", "Checking Workers"]) {
  await ui.run(`${label} (simulated)`, () => pause(500));
}

ui.section("Worker deployment");
ui.note("Running the real local Astro build; full output follows.");
const build = Bun.spawn({
  cmd: [process.execPath, "run", "build"],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const buildExitCode = await build.exited;
if (buildExitCode !== 0) {
  ui.failure(`Local build failed with exit code ${buildExitCode}`);
  process.exit(buildExitCode);
}

ui.section("Final verification");
await ui.run("Verifying custom domain and site response (simulated)", () => pause(700));
ui.success("Preview complete. Nothing was deployed.");
