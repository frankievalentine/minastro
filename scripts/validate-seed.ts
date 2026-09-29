import { validateSeed } from "emdash/seed";
import { createTerminalUI } from "./terminal-ui";

const ui = createTerminalUI();
ui.section("EmDash seed validation");

const seedFile = Bun.file(new URL("../.emdash/seed.json", import.meta.url));
const seed = await seedFile.json();
const result = validateSeed(seed);

if (!result.valid) {
  ui.failure("EmDash seed validation failed");
  for (const error of result.errors) {
    console.error(typeof error === "string" ? error : JSON.stringify(error));
  }
  process.exit(1);
}

for (const warning of result.warnings) {
  console.warn(typeof warning === "string" ? warning : JSON.stringify(warning));
}

ui.success("EmDash seed is valid");
