import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER_CONFIG = new URL("../wrangler.jsonc", import.meta.url);
const SITE_CONFIG = new URL("../src/site.config.ts", import.meta.url);
const D1_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const R2_PLACEHOLDER = "minastro-template-media";
const WORKER_PLACEHOLDER = "minastro-template";
const SESSION_PLACEHOLDER = "00000000000000000000000000000000";

type CommandOptions = { input?: string; quiet?: boolean };

const normalizeName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

async function run(command: string[], options: CommandOptions = {}) {
  const child = Bun.spawn({
    cmd: command,
    cwd: PROJECT_ROOT,
    stdin: options.input ? new Blob([options.input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed.\n${stderr || stdout}`.trim());
  }

  if (!options.quiet && stdout.trim()) {
    console.log(stdout.trim());
  }

  return stdout.trim();
}

async function runInteractive(command: string[]) {
  const child = Bun.spawn({
    cmd: command,
    cwd: PROJECT_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed.`);
  }
}

function replaceConfigValue(config: string, property: string, value: string) {
  const pattern = new RegExp(`("${property}"\\s*:\\s*)"[^"]*"`);
  if (!pattern.test(config)) {
    throw new Error(`Could not find ${property} in wrangler.jsonc.`);
  }
  return config.replace(pattern, `$1"${value}"`);
}

function readConfigValue(config: string, property: string) {
  const match = config.match(new RegExp(`"${property}"\\s*:\\s*"([^"]+)"`));
  if (!match) {
    throw new Error(`Could not read ${property} from wrangler.jsonc.`);
  }
  return match[1];
}

function appendD1Database(config: string, database: Record<string, string>) {
  if (config.includes('"binding": "NEWSLETTER_DB"')) {
    throw new Error("NEWSLETTER_DB is already configured. Review the existing newsletter setup before rerunning this command.");
  }

  const pattern = /("d1_databases"\s*:\s*\[)([\s\S]*?)(\n\s{2}\])/;
  if (!pattern.test(config)) {
    throw new Error("Could not add NEWSLETTER_DB to wrangler.jsonc.");
  }

  return config.replace(pattern, (_match, opening, entries, closing) =>
    `${opening}${entries.trimEnd()},\n    ${JSON.stringify(database)}${closing}`,
  );
}

function appendTopLevelArray(config: string, property: string, entry: Record<string, unknown>) {
  if (config.includes(`"${property}"`)) {
    throw new Error(`${property} is already configured. Review the existing newsletter setup before rerunning this command.`);
  }

  if (!/\n}\s*$/.test(config)) {
    throw new Error("Could not add a binding to wrangler.jsonc.");
  }

  return config.replace(
    /\n}(\s*)$/,
    `,\n  "${property}": [\n    ${JSON.stringify(entry)}\n  ]\n}$1`,
  );
}

function appendTopLevelObject(config: string, property: string, value: Record<string, string>) {
  if (config.includes(`"${property}"`)) {
    throw new Error(`${property} is already configured. Add RESEND_SEGMENT_ID manually before rerunning setup.`);
  }

  if (!/\n}\s*$/.test(config)) {
    throw new Error("Could not add configuration to wrangler.jsonc.");
  }

  return config.replace(
    /\n}(\s*)$/,
    `,\n  "${property}": ${JSON.stringify(value)}\n}$1`,
  );
}

function hostname(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^(localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/.test(normalized)) {
    throw new Error("Enter a hostname only, without a protocol, path, or port.");
  }
  return normalized;
}

function emailAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Enter a valid sender email address.");
  }
  return normalized;
}

function positiveInteger(value: string) {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("The rate-limit namespace ID must be a positive integer.");
  }
  return normalized;
}

function updateNewsletterSiteConfig(
  source: string,
  values: { senderAddress: string; turnstileSiteKey: string; consentVersion: string; expectedHostname: string },
) {
  const start = source.indexOf("newsletter: {");
  const end = source.indexOf("\n  },", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not find the newsletter configuration in src/site.config.ts.");
  }

  let block = source.slice(start, end);
  const replacements: Record<string, string | boolean> = {
    enabled: true,
    senderAddress: values.senderAddress,
    turnstileSiteKey: values.turnstileSiteKey,
    consentVersion: values.consentVersion,
    expectedHostname: values.expectedHostname,
  };

  for (const [property, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`(\\b${property}:\\s*)(?:true|false|"(?:[^"\\\\]|\\\\.)*")`);
    if (!pattern.test(block)) {
      throw new Error(`Could not update newsletter.${property} in src/site.config.ts.`);
    }
    block = block.replace(pattern, `$1${typeof value === "boolean" ? value : JSON.stringify(value)}`);
  }

  return `${source.slice(0, start)}${block}${source.slice(end)}`;
}

function parseResourceId(output: string, resource: string) {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const id = [parsed.uuid, parsed.database_id, parsed.namespace_id, parsed.id].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!id) {
    throw new Error(`Wrangler created ${resource} but did not return its ID. Configure it manually before rerunning setup.`);
  }
  return id;
}

const readline = createInterface({ input, output });

try {
  await run(["bunx", "wrangler", "whoami"], { quiet: true });

  let config = await Bun.file(WRANGLER_CONFIG).text();
  const corePlaceholders = [D1_PLACEHOLDER, R2_PLACEHOLDER, WORKER_PLACEHOLDER, SESSION_PLACEHOLDER];
  const missingCorePlaceholders = corePlaceholders.filter((placeholder) => !config.includes(placeholder));
  const coreIsUnconfigured = missingCorePlaceholders.length === 0;
  const coreIsConfigured = missingCorePlaceholders.length === corePlaceholders.length;
  let workerName: string;
  let deployRequired = false;

  if (!coreIsUnconfigured && !coreIsConfigured) {
    throw new Error("wrangler.jsonc contains partial core bindings. Review it before rerunning setup to avoid duplicate resources.");
  }

  if (coreIsUnconfigured) {
    workerName = normalizeName((await readline.question("Worker name [my-site]: ")) || "my-site");
    if (!workerName) {
      throw new Error("Worker name must include at least one letter or number.");
    }

    const defaultD1Name = `${workerName}-db`;
    const databaseName = normalizeName(
      (await readline.question(`D1 database name [${defaultD1Name}]: `)) || defaultD1Name,
    );
    const defaultBucketName = `${workerName}-media`;
    const bucketName = normalizeName(
      (await readline.question(`R2 bucket name [${defaultBucketName}]: `)) || defaultBucketName,
    );

    const confirmation = await readline.question(
      `Create Worker ${workerName}, D1 ${databaseName}, R2 ${bucketName}, and session storage? [y/N] `,
    );
    if (!/^y(es)?$/i.test(confirmation.trim())) {
      console.log("Setup cancelled. No Cloudflare resources were created.");
      process.exit(0);
    }

    const databaseOutput = await run(["bunx", "wrangler", "d1", "create", databaseName, "--json"], { quiet: true });
    const databaseId = parseResourceId(databaseOutput, "the D1 database");
    config = replaceConfigValue(config, "name", workerName);
    config = replaceConfigValue(config, "database_name", databaseName);
    config = replaceConfigValue(config, "database_id", databaseId);
    await Bun.write(WRANGLER_CONFIG, config);

    await run(["bunx", "wrangler", "r2", "bucket", "create", bucketName]);
    config = replaceConfigValue(config, "bucket_name", bucketName);
    await Bun.write(WRANGLER_CONFIG, config);

    const sessionOutput = await run(
      ["bunx", "wrangler", "kv", "namespace", "create", `${workerName}-sessions`, "--json"],
      { quiet: true },
    );
    config = replaceConfigValue(config, "id", parseResourceId(sessionOutput, "the session namespace"));
    await Bun.write(WRANGLER_CONFIG, config);

    const encryptionKey = await run(["bunx", "emdash", "secrets", "generate"], { quiet: true });
    if (!encryptionKey) {
      throw new Error("EmDash did not generate an encryption key.");
    }
    await run(["bunx", "wrangler", "secret", "put", "EMDASH_ENCRYPTION_KEY"], {
      input: `${encryptionKey}\n`,
      quiet: true,
    });
    deployRequired = true;
  } else {
    workerName = readConfigValue(config, "name");
    console.log(`Core resources are already configured for ${workerName}.`);
  }

  const newsletterConfigured = config.includes('"binding": "NEWSLETTER_DB"');
  if (newsletterConfigured) {
    console.log("Newsletter resources are already configured; no newsletter changes were made.");
  } else {
    const enableNewsletter = await readline.question("Configure the optional newsletter now? [y/N] ");
    if (/^y(es)?$/i.test(enableNewsletter.trim())) {
      console.log("Newsletter setup sends only double-opt-in transactional email. Verify the sender domain in Cloudflare Email Sending and create a Turnstile widget before continuing.");
      const expectedHostname = hostname(await readline.question("Turnstile hostname (for example, newsletter.example.com): "));
      const senderAddress = emailAddress(await readline.question("Verified sender address: "));
      const turnstileSiteKey = (await readline.question("Existing Turnstile site key: ")).trim();
      if (!turnstileSiteKey) {
        throw new Error("A Turnstile site key is required when enabling the newsletter.");
      }
      const rateLimitNamespaceId = positiveInteger(await readline.question("Rate-limit namespace ID: "));
      const consentVersion = (await readline.question("Consent version [1.0]: ")).trim() || "1.0";
      const newsletterDatabaseName = `${workerName}-newsletter`;

      const confirmation = await readline.question(
        `Create ${newsletterDatabaseName}, apply its remote migration, enable newsletter signup for ${expectedHostname}, and configure transactional sender ${senderAddress}? [y/N] `,
      );
      if (/^y(es)?$/i.test(confirmation.trim())) {
        const newsletterOutput = await run(
          ["bunx", "wrangler", "d1", "create", newsletterDatabaseName, "--json"],
          { quiet: true },
        );
        const newsletterDatabaseId = parseResourceId(newsletterOutput, "the newsletter D1 database");
        config = appendD1Database(config, {
          binding: "NEWSLETTER_DB",
          database_name: newsletterDatabaseName,
          database_id: newsletterDatabaseId,
          migrations_dir: "newsletter-migrations",
        });
        config = appendTopLevelArray(config, "send_email", {
          name: "NEWSLETTER_EMAIL",
          remote: true,
          allowed_sender_addresses: [senderAddress],
        });
        config = appendTopLevelArray(config, "ratelimits", {
          name: "NEWSLETTER_SUBSCRIBE_LIMITER",
          namespace_id: rateLimitNamespaceId,
          simple: { limit: 5, period: 60 },
        });
        await Bun.write(WRANGLER_CONFIG, config);
        await run(["bunx", "wrangler", "d1", "migrations", "apply", "NEWSLETTER_DB", "--remote"]);

        console.log("Enter the Turnstile secret when Wrangler prompts. It is stored as a Worker secret and is never written to this repository.");
        await runInteractive(["bunx", "wrangler", "secret", "put", "TURNSTILE_SECRET_KEY"]);
        console.log("Enter a separate newsletter admin token when Wrangler prompts. Keep it in a password manager; it protects CSV exports.");
        await runInteractive(["bunx", "wrangler", "secret", "put", "NEWSLETTER_ADMIN_TOKEN"]);

        const siteConfig = await Bun.file(SITE_CONFIG).text();
        await Bun.write(
          SITE_CONFIG,
          updateNewsletterSiteConfig(siteConfig, {
            senderAddress,
            turnstileSiteKey,
            consentVersion,
            expectedHostname,
          }),
        );
        deployRequired = true;
      } else {
        console.log("Newsletter setup skipped. Core setup can still continue.");
      }
    }
  }

  if (config.includes('"binding": "NEWSLETTER_DB"') && !config.includes('"RESEND_SEGMENT_ID"')) {
    const enableResend = await readline.question("Configure optional Resend Segment synchronization now? [y/N] ");
    if (/^y(es)?$/i.test(enableResend.trim())) {
      console.log("Resend campaigns are created and sent in the Resend dashboard. This Worker only synchronizes confirmed subscribers to one Segment.");
      const resendSegmentId = (await readline.question("Resend Segment ID: ")).trim();
      if (!resendSegmentId) {
        throw new Error("A Resend Segment ID is required.");
      }
      const confirmation = await readline.question(
        `Apply the Resend outbox migration and configure Segment ${resendSegmentId}? [y/N] `,
      );
      if (/^y(es)?$/i.test(confirmation.trim())) {
        config = appendTopLevelObject(config, "vars", { RESEND_SEGMENT_ID: resendSegmentId });
        await Bun.write(WRANGLER_CONFIG, config);
        await run(["bunx", "wrangler", "d1", "migrations", "apply", "NEWSLETTER_DB", "--remote"]);
        console.log("Enter the Resend full-access API key when Wrangler prompts. It is stored as a Worker secret and never sent to the browser.");
        await runInteractive(["bunx", "wrangler", "secret", "put", "RESEND_API_KEY"]);
        deployRequired = true;
      } else {
        console.log("Resend synchronization skipped.");
      }
    }
  }

  if (deployRequired) {
    const deploymentOutput = await run(["bun", "run", "cf:deploy"]);
    const workerUrl = deploymentOutput.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
    if (workerUrl) {
      console.log(`\nDeployment complete:\n  ${workerUrl}\n  ${workerUrl}/_emdash/admin`);
    } else {
      console.log("\nDeployment complete. Wrangler printed the Worker URL above; open /_emdash/admin there to finish setup.");
    }
  }

  console.log("\nConnect a custom domain and configure DNS in Cloudflare separately.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  readline.close();
}
