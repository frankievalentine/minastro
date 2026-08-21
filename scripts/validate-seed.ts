import { validateSeed } from "emdash/seed";

const seedFile = Bun.file(new URL("../.emdash/seed.json", import.meta.url));
const seed = await seedFile.json();
const result = validateSeed(seed);

if (!result.valid) {
  console.error("EmDash seed validation failed.");
  for (const error of result.errors) {
    console.error(typeof error === "string" ? error : JSON.stringify(error));
  }
  process.exit(1);
}

for (const warning of result.warnings) {
  console.warn(typeof warning === "string" ? warning : JSON.stringify(warning));
}

console.log("EmDash seed is valid.");
