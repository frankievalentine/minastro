# Newsletter

This document describes the newsletter subsystem: how it works, what you need
to provision, and how to operate it.

---

## Architecture overview

The newsletter is a **first-party, zero-dependency** subscription system built
on Cloudflare D1 (for storage) and Cloudflare Email Sending (for delivery).

**What it handles:**
- Subscription form submission (email capture + Turnstile verification)
- Confirmation email with one-time token link (fragment-based `#token=...`)
- One-click unsubscribe (stable token, no login required)
- Status lifecycle: `pending` -> `active` -> `unsubscribed`, with protected
  operator-controlled `erasure_pending` while cross-system deletion runs
- Consent version tracking for privacy compliance
- Full audit log of every state change (via database triggers)
- Per-IP rate limiting via Cloudflare Rate Limiting binding

**What it does NOT handle:**
- Bulk email campaigns (scheduled sends, templates, segmentation, analytics).
  For campaigns you need a dedicated bulk ESP (e.g. EmailOctopus, Buttondown,
  Mailchimp, Resend). The newsletter DB is designed to be exportable for
  import into any ESP.
- One-click unsubscribe (RFC 8058 / List-Unsubscribe-Post header). The
  application does not claim `List-Unsubscribe` header management -- that is
  the responsibility of whichever ESP sends your bulk campaigns. The
  application's unsubscribe link is a stable token-based URL that you include
  in your email content. If you use an external ESP for campaigns, that ESP
  owns its own suppression-list synchronization and unsubscribe-header
  management.

---

## Configuration

### `src/site.config.ts`

```typescript
newsletter: {
  enabled: false,              // set to true when ready
  description: "Occasional notes on engineering, projects, and ideas. No spam.",
  senderAddress: "newsletter@your-domain.com",  // must match allowed_sender_addresses
  turnstileSiteKey: "",        // public Turnstile site key (written here by setup)
  consentVersion: "1.0",       // bump when privacy policy changes
  expectedHostname: "your-domain.com",  // must match Turnstile widget domain
}
```

| Field | Purpose |
|---|---|
| `enabled` | Master toggle. When `false`, the public page shows a disabled setup state and subscription requests remain unavailable. |
| `description` | Shown below the subscribe form to set expectations. |
| `senderAddress` | Verified sender address for transactional emails. Must match an address in the `send_email` binding's `allowed_sender_addresses`. |
| `turnstileSiteKey` | Public Turnstile site key rendered in the widget. **Required when newsletter is enabled.** |
| `consentVersion` | Semver string identifying the consent version the subscriber agreed to. Increment when your privacy policy changes. Existing subscribers retain the version they agreed to. |
| `expectedHostname` | The hostname Turnstile validates against. Must match the domain where the widget is rendered. |

### Environment variables / secrets

| Variable | Source | Required | Purpose |
|---|---|---|---|
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile dashboard | Yes (when newsletter enabled) | Server-side verification of Turnstile tokens. Set via `bunx wrangler secret put TURNSTILE_SECRET_KEY`. |

### Bindings (wrangler config)

The newsletter uses three bindings that are **separate from the main EmDash
bindings**. The recommended setup flow writes them to `wrangler.jsonc` when
newsletter provisioning is enabled.

| Binding | Type | Purpose |
|---|---|---|
| `NEWSLETTER_DB` | D1 database | Subscriber storage and audit log. Separate from the main EmDash `DB` to keep concerns isolated. |
| `NEWSLETTER_EMAIL` | Email Sending (`send_email`) | Transactional email delivery (confirmation emails). Configured with `allowed_sender_addresses`. |
| `NEWSLETTER_SUBSCRIBE_LIMITER` | Rate Limiter (`ratelimits`) | Endpoint-scoped per-IP rate limiting for subscribe, confirm, and unsubscribe (5 requests per 60 seconds per endpoint). |

**All three bindings are required when newsletter is enabled.** If any binding
is missing, the newsletter endpoints return 503. Turnstile and the rate limiter
are not optional -- they are mandatory protections against automated abuse.

**Binding repetition for environments**: When using named environments in
`wrangler.jsonc` (e.g. `preview`, `production`), bindings must be repeated
per environment block. Each environment needs its own `d1_databases`,
`send_email`, and `ratelimits` entries with the correct `database_id` and
rate limit configuration for that environment.

---

## Provisioning

These steps are required before the newsletter can function. They are
**deploy-required** -- not needed for local dev unless you are testing the
full flow.

### Recommended setup flow

Run `bun run cloudflare:setup` after provisioning the core site. The command offers an opt-in newsletter phase that creates `NEWSLETTER_DB`, writes the D1, Email Sending, and rate-limit bindings, applies and verifies the remote migration, adds `TURNSTILE_SECRET_KEY` and the export token through masked prompts and `wrangler versions secret put`, writes the public Turnstile configuration to `src/site.config.ts`, enables the newsletter, and deploys the prepared version only after those prerequisites are verified. It uses the approved account-scoped Cloudflare token described in [the operations guide](operations.md); the token is never stored or logged.

Before accepting that phase, complete these account-level prerequisites:

1. Onboard and verify the sender domain in Cloudflare Email Sending, including its required DNS records.
2. Create a Turnstile widget for the newsletter hostname and have its public site key and private secret ready. The command accepts the secret through no-echo input and never writes it to the repository or journal.
3. Obtain a positive Cloudflare Workers Rate Limiting namespace ID for `NEWSLETTER_SUBSCRIBE_LIMITER`.

The setup command sends only double-opt-in confirmation emails. It does not configure or send bulk newsletter campaigns. Optional Resend synchronization places confirmed subscribers in a Resend Segment; create and send Broadcasts in Resend.

The setup command is resumable. Its journal contains only resource identities,
milestones, and secret-operation states under `.wrangler/provisioning/`; secret
values and bootstrap URLs are never written there. If the database, migration,
secret upload, or deployment step is interrupted, rerun the command. It
revalidates remote state and does not retry an ambiguous resource creation or
silently replace an existing secret. A pending secret upload requires the
operator to recover the saved value from the password manager.

For an existing Resend-enabled database, setup repeatedly requires confirmation
that the legacy drainer is paused, all legacy rows are treated as potentially
uncertain, and remote mutations are quiescent or explicitly quarantined. Applying
the migration alone does not release that prerequisite; setup releases it only
after the new Worker version and deployment identity are verified.

### Local configuration is not bindings

`.dev.vars` stores local secret values only. It does **not** create the D1,
Email Sending, or Rate Limiting bindings required by the newsletter. For a
full local flow, configure those bindings in `wrangler.jsonc` (or use the
automated setup flow) and run the Worker with Wrangler. The public newsletter
page intentionally remains visible in its disabled state until all production
requirements are configured.

## Security & compliance

### Token design

| Token | Type | Lifetime | Purpose |
|---|---|---|---|
| `confirmation_token_hash` | SHA-256 hash | One-time; cleared on confirm | Email verification link |
| `unsubscribe_token` | Raw (recoverable) | Permanent | Stable unsubscribe link |

- The confirmation token is stored as a **SHA-256 hash**. If the database is
  compromised, confirmation tokens cannot be reversed.
- The confirmation token is generated as 32 random bytes (base64url) and has a
  24-hour expiry. It is single-use -- once confirmed, the hash is cleared.
- The unsubscribe token is stored in **plain text** (recoverable) so it can be
  included in unsubscribe links. It is generated once at subscription and
  preserved on resubscribe from unsubscribed. It never changes, so unsubscribe
  links in old emails remain valid.

### Data retention

- **Normal subscriber rows are retained.** Status transitions (`active` ->
  `unsubscribed`) are the source of truth for ordinary lifecycle changes.
- **Erasure is a separate, verified workflow.** An operator must request
  erasure by subscriber ID with `bun run newsletter:erase -- <id>`. The command
  previews only the ID and row counts, requires typing `ERASE`, and never
  displays or logs the email address, tokens, or Resend contact ID. It marks
  the row `erasure_pending`, clears public confirmation state, and queues an
  `erase` outbox operation.
- **Remote deletion precedes local deletion.** The Worker resolves the
  retained normalized email to an exact Resend contact ID, persists that ID,
  deletes by ID, and independently verifies a 404 absence. Only then is the
  local subscriber, audit history, and outbox identity row deleted in one
  transaction. The aggregate completion counter contains no subscriber
  identity.
- **Unknown outcomes are quarantined.** Timeouts, network failures, malformed
  responses, authorization errors, and persistence failures after a possible
  mutation retain the subscriber, audit rows, and outbox identity forever in
  `uncertain`. They are not automatically retried or taken over. A saved
  `remote_deleted` checkpoint retries only local finalization.
- **Public lifecycle operations cannot undo erasure.** Subscribe, confirm,
  unsubscribe, and the active export exclude or reject `erasure_pending` rows.
- This workflow does not claim that backups, independent exports, provider
  logs, or application logs have been erased; those retention systems require
  separate operator procedures.
- **Pending-subscriber retention**: Unconfirmed subscribers are retained
  so they can request a new confirmation email. The 24-hour
  `confirmation_expires_at` prevents use of stale tokens. To purge
  unconfirmed rows after a 7-day grace period, run a separate scheduled
  script:
  ```sql
  DELETE FROM newsletter_subscribers
  WHERE status = 'pending'
    AND requested_at < datetime('now', '-7 days');
  ```
- **Right to erasure (GDPR)**: Use the operator command and wait for its
  durable remote-deletion checkpoint before local finalization. Never manually
  anonymize or delete a row while an outbox operation is `running` or
  `uncertain`; doing so can make a later Resend mutation impossible to resolve.
- **Right to data portability (GDPR)**:
  ```sql
  SELECT email, name, status, requested_at, first_confirmed_at, created_at
  FROM newsletter_subscribers
  WHERE status = 'active'
  ORDER BY created_at DESC;
  ```

### Rate limiting

The subscribe, confirm, and unsubscribe endpoints are each rate-limited per IP
via the `NEWSLETTER_SUBSCRIBE_LIMITER` Rate Limiting binding (configured at 5
requests per 60 seconds per endpoint in the example config). The keys are
endpoint-scoped (`subscribe:<IP>`, `confirm:<IP>`, and `unsubscribe:<IP>`), so
a signup burst does not consume the allowance for a valid confirmation or
unsubscribe link. When a limit is exceeded, the endpoint returns a generic 429
response. If the required binding is missing or fails, the endpoint returns
503 rather than attempting the protected operation.

### Public API response semantics

All newsletter JSON request bodies are limited to 8,192 UTF-8 bytes and have a
finite five-second read deadline. Oversized, timed-out, malformed, or
incompatible requests receive the endpoint's existing generic 400 response.

After request validation, rate limiting, and Turnstile verification, subscribe
returns the same public status and body for every accepted request:
`202` with `{"success":true}`. This does not reveal whether the address was
new, pending, already active, or resubscribed. It is a status/body guarantee,
not a timing guarantee. Confirmation email delivery remains synchronous: the
endpoint attempts the email send before returning the accepted response, and
does not move delivery to a background queue.

Confirm and unsubscribe likewise return `200` with `{"success":true}` for any
valid-shaped token, whether it is unknown, expired, replayed, or successful;
malformed requests and rate-limited requests retain their generic `400` and
`429` responses.

### Turnstile

Turnstile is used on the subscribe form to prevent automated submissions.
The server verifies every token with these checks:
- `success` must be `true`
- `action` must match `newsletter_subscribe`
- `hostname` must match the configured `expectedHostname` exactly
- `remoteip` is passed for server-side validation
- Fail-closed: any unexpected response returns `false`

Turnstile is **required** when newsletter is enabled. If the
`TURNSTILE_SECRET_KEY` secret is not set, the endpoint returns 503.

---

## Bulk email campaigns

Cloudflare Email Sending delivers only double-opt-in confirmation messages.
Bulk campaigns are authored, scheduled, and sent by an ESP.

### Optional Resend Segment synchronization

`bun run cloudflare:setup` can configure a [Resend Segment](https://resend.com/docs/dashboard/segments) integration. Resend Audiences are deprecated; use a Segment ID.

The newsletter D1 database remains authoritative. Every subscriber status transition writes a coalescing outbox row, and the existing one-minute Worker cron synchronizes the latest desired state to the configured Resend Segment:

- Confirmed subscribers are added to the Segment.
- Unsubscribed or pending subscribers are removed from the Segment.
- Durable outbox rows are `ready`, `running`, `uncertain`, or
  `remote_deleted`. Only `ready` rows are claimable. A running lease that expires is moved to `uncertain`, retaining
  its owner and claimed revision; it is never automatically reclaimed.
- Migration `0003_resend_quarantine.sql` conservatively converts every
  preexisting legacy outbox row to `uncertain`, including rows with no recorded
  lease. The legacy protocol could have submitted a remote mutation before
  losing its lease state, so the absence or expiry of a lease is not evidence
  that a row is safe to retry.
- Definitive HTTP failures release ownership and retry with backoff. Network
  failures, timeouts, and ambiguous responses from a submitted mutation, plus
  worker-crash watchdog transitions, become `uncertain` and never retry
  automatically. Membership-read failures, malformed membership payloads, and
  paginated membership responses remain `ready` with backoff because no remote
  mutation was submitted.
- Status changes during a remote operation retain the live lease. Completion
  atomically makes a newer revision ready, or deletes the row only when the
  owned claimed revision is still current. This prevents remote side effects
  for one subscriber from overlapping across revisions.
- These synchronization states never affect confirmation or unsubscribe
  responses.

#### Existing-site migration cutover

Do not live-upgrade an active `0002` drainer. For an existing newsletter
database, use this order:

1. Pause the old Worker cron/drain lane and verify from the deployment control
   plane and logs that no old drainer invocation can start or is still running.
2. Resolve every potentially old operation before migration. Treat every
   preexisting legacy outbox row as potentially uncertain, including rows with
   no recorded lease. Obtain evidence that a submitted Resend mutation
   completed or cannot apply later. If that evidence is unavailable, preserve
   the row for `0003_resend_quarantine.sql` to place in `uncertain`; do not
   clear or promote any legacy row to `ready` based on a missing or expired
   lease.
3. Apply the newsletter migrations, including `0003_resend_quarantine.sql` and
   `0004_newsletter_erasure.sql`, while the old drainer remains paused.
4. Deploy the new drainer, verify the deployed version, and only then resume
   the Worker cron/drain lane.

The setup command requires an explicit confirmation of this pause and
reconciliation before applying the Resend migration on an existing site. A
lease duration expiring is not evidence that an old invocation or a submitted
remote mutation has stopped or cannot later apply.

#### Recovering `uncertain` work

`uncertain` is a deliberate quarantine, not a retry queue. Before recovering a
row, establish remote quiescence with evidence from the deployment control
plane and Worker logs that no old or current drainer invocation can start or is
still running. Also establish that the old submitted Resend mutation completed
or cannot apply later, using the provider's operation evidence or an equivalent
proof that the request was not accepted and cannot be applied. **Membership
observation alone is insufficient unless both forms of quiescence have been
established.** A remote call may have succeeded even when its response was
lost; elapsed lease time is explicitly insufficient.

After quiescence, compare the authoritative subscriber status with the Resend
Segment membership. Recovery is split by operation; every statement matches the
subscriber, owner token, claimed revision, claimed operation, and exact erase
credential/contact binding, and clears all ownership fields together.

For ordinary Segment synchronization only:

```sql
UPDATE resend_sync_outbox
SET state = 'ready',
    attempt_count = CASE WHEN revision != claimed_revision THEN 0 ELSE attempt_count END,
    lease_token = NULL,
    lease_expires_at = NULL,
    claimed_operation = NULL,
    claimed_revision = NULL,
    resend_contact_id = NULL,
    resend_credential_fingerprint = NULL,
    erasure_path = 'resend',
    remote_state = 'none',
    next_attempt_at = datetime('now'),
    updated_at = datetime('now')
WHERE subscriber_id = <SUBSCRIBER_ID>
  AND state = 'uncertain'
  AND lease_token = '<OWNER_TOKEN>'
  AND claimed_operation = 'sync'
  AND claimed_revision = <CLAIMED_REVISION>;
```

For an erase lookup that never persisted a contact ID, and only after the
operator verifies the credential is the same intended account:

```sql
UPDATE resend_sync_outbox
SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
    claimed_operation = NULL, claimed_revision = NULL,
    next_attempt_at = datetime('now'), last_error_code = NULL,
    updated_at = datetime('now')
WHERE subscriber_id = <SUBSCRIBER_ID>
  AND operation = 'erase' AND state = 'uncertain'
  AND lease_token = '<OWNER_TOKEN>' AND claimed_operation = 'erase'
  AND claimed_revision = <CLAIMED_REVISION>
  AND resend_contact_id IS NULL AND remote_state = 'none'
  AND resend_credential_fingerprint = '<APPROVED_FINGERPRINT>';
```

For delete-uncertain work, retry only after evidence proves the previous
delete was not accepted. The frozen contact ID and account fingerprint are
mandatory:

```sql
UPDATE resend_sync_outbox
SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
    claimed_operation = NULL, claimed_revision = NULL,
    next_attempt_at = datetime('now'), last_error_code = NULL,
    updated_at = datetime('now')
WHERE subscriber_id = <SUBSCRIBER_ID>
  AND operation = 'erase' AND state = 'uncertain'
  AND lease_token = '<OWNER_TOKEN>' AND claimed_operation = 'erase'
  AND claimed_revision = <CLAIMED_REVISION>
  AND resend_contact_id = '<FROZEN_CONTACT_ID>'
  AND remote_state = 'none'
  AND resend_credential_fingerprint = '<APPROVED_FINGERPRINT>';
```

If independent provider evidence proves the frozen contact is already absent,
record the terminal checkpoint instead; do not replay DELETE:

```sql
UPDATE resend_sync_outbox
SET state = 'remote_deleted', remote_state = 'remote_deleted',
    lease_token = NULL, lease_expires_at = NULL,
    claimed_operation = NULL, claimed_revision = NULL,
    last_error_code = NULL, updated_at = datetime('now')
WHERE subscriber_id = <SUBSCRIBER_ID>
  AND operation = 'erase' AND state = 'uncertain'
  AND lease_token = '<OWNER_TOKEN>' AND claimed_operation = 'erase'
  AND claimed_revision = <CLAIMED_REVISION>
  AND resend_contact_id = '<FROZEN_CONTACT_ID>'
  AND remote_state = 'none'
  AND resend_credential_fingerprint = '<APPROVED_FINGERPRINT>';
```

The next drain finalizes `remote_deleted` locally without requiring Resend
configuration. Never reuse an owner token, substitute a contact ID, mark work
`running` manually, or release a row when quiescence/account evidence is
missing. A changed API key requires explicit `REBIND_SAME_ACCOUNT` approval
after checking the intended account in the Resend operator console.

The setup command prompts for `RESEND_SEGMENT_ID` and stores `RESEND_API_KEY` as a Worker secret. Resend currently requires a full-access key for contact operations; use a dedicated Resend account if that scope is unacceptable.

Create and send Broadcasts in the Resend dashboard, targeting this Segment. Do not target all contacts. Resend owns Broadcast unsubscribe headers and global suppression; this integration deliberately does not clear a contact's global Resend unsubscribe state.

#### Cross-system erasure

The erasure outbox operation is deliberately stricter than Segment
synchronization:

- Each erase row stores a SHA-256 custody fingerprint of the operator-approved
  initial `RESEND_API_KEY`. The contacts API has no documented account identity,
  so a changed key fails closed before any lookup, delete, or recovery. Use the
  operator command with `--rebind` only after independently verifying that the
  replacement key belongs to the same intended Resend account; the approval is
  recorded by incrementing the durable rebind revision.
- The initial contact lookup accepts only a Resend contact object with
  `object: "contact"`, an `id`, and an exactly matching normalized email.
- Resend responses must be HTTPS JSON from the exact requested URL. Redirects,
  HTML, malformed bodies, and generic 404s are rejected. A not-found response
  is accepted only with the provider error shape `statusCode: 404` and
  `message: "Contact not found"` for the exact frozen contact request.
- The immutable saved ID is used for `DELETE /contacts/{id}`. Segment removal
  is not a substitute for contact deletion.
- A successful delete response must identify the same contact and contain
  `deleted: true`; a delete 404 is accepted only when a separate GET by the
  saved ID confirms 404 absence.
- Any non-404 verification response or ambiguous response remains quarantined.
- A verified initial email lookup absence may complete without DELETE. A
  separately approved `--local-only` request may complete without Resend only
  when the deployment is explicitly marked local-only and has no recorded
  remote evidence; missing credentials by itself never authorizes deletion.
- `remote_deleted` is a local checkpoint, not evidence that external backups,
  exports, logs, or provider retention have been erased.

Before an erasure request is admitted, confirmation-email admissions are
atomically paused. Confirmation sends already admitted before the pause are
counted durably and must drain before the erase worker performs any remote or
local completion. Admissions reopen after the erase reaches a durable
checkpoint/failure and local finalization is safe; a held send cannot race
local deletion.

### Observability and alerting

Newsletter server and outbox logs are newline-delimited JSON records emitted by
the Worker. They use only these event names:

- `newsletter_confirmation_delivery` with `operation: "confirmation"` and
  `state: "accepted"` or `"failed"`.
- `newsletter_outbox_retry` with `operation: "sync"` or `"erase"` and the
  durable outbox `revision`.
- `newsletter_outbox_quarantine` for uncertainty, lease expiry, or invalid
  remote outcomes.
- `newsletter_outbox_finalization` for local completion or finalization
  failure.
- `newsletter_scheduled_maintenance_failure` for a failed scheduled outbox
  drain.

Records contain only `event`, `operation`, `revision` when available, `state`,
and a bounded `error_class`. They never contain email addresses, names, tokens,
contact IDs, request bodies, provider response bodies, or raw exception text.
Public API responses remain the existing generic responses.

Cloudflare Worker observability is intentionally not enabled in
`wrangler.jsonc`: enabling plan-dependent logs or tracing there could change
deployment cost and retention semantics. Enable the Worker Logs/Observability
view in the Cloudflare dashboard for the deployed Worker, then create alerts
using the JSON event fields. No third-party log or alert service is required.

Recommended dashboard checks:

1. Alert when confirmation delivery failures are sustained, for example five
   `newsletter_confirmation_delivery` events with `state: "failed"` in ten
   minutes; compare with accepted events before treating a short burst as an
   outage.
2. Alert when D1 reports any growing or old uncertainty:

   ```sql
   SELECT COUNT(*) AS uncertain_count, MIN(updated_at) AS oldest_uncertain_at
   FROM resend_sync_outbox
   WHERE state = 'uncertain';
   ```

3. Alert on a growing retry backlog, using only aggregate counts:

   ```sql
   SELECT COUNT(*) AS due_retry_count, MIN(next_attempt_at) AS oldest_due_at
   FROM resend_sync_outbox
   WHERE state = 'ready' AND next_attempt_at <= datetime('now');
   ```

4. Alert on any sustained `newsletter_scheduled_maintenance_failure` or
   `newsletter_outbox_finalization` event with `state: "failed"`.

Keep dashboard queries and exports aggregate-only. Apply the Worker Logs
retention available to the account, avoid exporting raw request/response data,
and restrict log access to operators. Log retention does not extend or replace
the D1 erasure guarantees; provider backups, exports, and suppression records
remain separate systems.

### CSV export

The active subscriber export is available only to an operator:

```text
GET /api/newsletter/admin/subscribers.csv
Authorization: Bearer <NEWSLETTER_ADMIN_TOKEN>
```

The response is uncached, excludes all confirmation and unsubscribe tokens, and contains `email`, `name`, `consent_version`, `first_confirmed_at`, and `created_at`. Set `NEWSLETTER_ADMIN_TOKEN` through the setup command or `wrangler secret put NEWSLETTER_ADMIN_TOKEN`; keep it in a password manager.

---

## Commands reference

```bash
# Apply migration (local)
bunx wrangler d1 migrations apply NEWSLETTER_DB --local

# Apply migration (remote/production)
bunx wrangler d1 migrations apply NEWSLETTER_DB --remote

# Set Turnstile secret
bunx wrangler secret put TURNSTILE_SECRET_KEY

# Set the protected CSV export token
bunx wrangler secret put NEWSLETTER_ADMIN_TOKEN

# Set the optional Resend Segment synchronization key
bunx wrangler secret put RESEND_API_KEY

# Request an approved cross-system erasure through the operator endpoint
NEWSLETTER_OPERATOR_URL=https://your-domain.com \
NEWSLETTER_ADMIN_TOKEN=<NEWSLETTER_ADMIN_TOKEN> \
bun run newsletter:erase -- <subscriber-id>

# Explicitly approve a verified local-only deployment (never used Resend)
NEWSLETTER_OPERATOR_URL=https://your-domain.com \
NEWSLETTER_ADMIN_TOKEN=<NEWSLETTER_ADMIN_TOKEN> \
bun run newsletter:erase -- --local-only <subscriber-id>

# Rebind one quarantined job after verifying the same intended Resend account
NEWSLETTER_OPERATOR_URL=https://your-domain.com \
NEWSLETTER_ADMIN_TOKEN=<NEWSLETTER_ADMIN_TOKEN> \
bun run newsletter:erase -- --rebind <subscriber-id>

`NEWSLETTER_OPERATOR_URL` must be an origin only: HTTPS is required except for
`localhost`, `127.0.0.1`, or `[::1]` development, with no credentials, query,
fragment, or path. The CLI displays the approved origin before its authenticated
preview and rejects redirects.

# Query active subscribers (production)
bunx wrangler d1 execute NEWSLETTER_DB --remote --command "SELECT email, created_at FROM newsletter_subscribers WHERE status = 'active' ORDER BY created_at DESC;"

# Export active subscribers to CSV (production)
curl --fail --show-error \
  -H "Authorization: Bearer <NEWSLETTER_ADMIN_TOKEN>" \
  https://your-domain.com/api/newsletter/admin/subscribers.csv \
  --output newsletter-subscribers.csv
```

---

## Schema

### `newsletter_subscribers`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, auto-increment |
| `email` | TEXT | Unique, not null |
| `name` | TEXT | Nullable display name |
| `status` | TEXT | `pending` / `active` / `unsubscribed` / `erasure_pending` |
| `confirmation_token_hash` | TEXT | SHA-256 hash, nullable (null after confirm) |
| `confirmation_expires_at` | TEXT | ISO-8601, 24 h from creation |
| `confirmation_admitted` | INTEGER | Durable confirmation-send admission flag |
| `confirmation_admission_id` | TEXT | Unique opaque admission owner, nullable |
| `unsubscribe_token` | TEXT | Raw recoverable token, unique, not null, stable |
| `last_confirmation_sent_at` | TEXT | ISO-8601, last confirmation send timestamp |
| `consent_version` | TEXT | Semver string, not null |
| `requested_at` | TEXT | ISO-8601, most recent subscription request |
| `first_confirmed_at` | TEXT | ISO-8601, nullable |
| `last_confirmed_at` | TEXT | ISO-8601, nullable |
| `last_unsubscribed_at` | TEXT | ISO-8601, nullable |
| `created_at` | TEXT | ISO-8601, row creation |
| `updated_at` | TEXT | ISO-8601, auto-updated via trigger |

### `audit_events`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, auto-increment |
| `subscriber_id` | INTEGER | FK -> newsletter_subscribers.id, CASCADE delete |
| `event_type` | TEXT | e.g. `subscribed`, `confirmed`, `unsubscribed`, `resubscribed` |
| `metadata` | TEXT | Optional JSON blob (e.g. `{"previous_status": "unsubscribed", "consent_version": "1.0"}`) |
| `created_at` | TEXT | ISO-8601 |

### Event types

| `event_type` | Triggered when |
|---|---|
| `subscribed` | Form submitted, row inserted |
| `confirmed` | Confirmation link clicked (status -> `active`) |
| `unsubscribed` | Unsubscribe link clicked (status -> `unsubscribed`) |
| `resubscribed` | Previously unsubscribed user re-subscribes (status -> `pending`) |
| `erasure_requested` | Operator requests cross-system erasure |

### `resend_sync_outbox`

The outbox has one coalesced row per subscriber. `operation` is `sync` for
ordinary Segment reconciliation or `erase` for cross-system deletion. Erasure
rows additionally retain `resend_contact_id` after contact resolution,
`remote_state = 'remote_deleted'` after independently verified absence, and
the claimed operation/revision needed for ownership fencing. Erase rows also
retain `resend_credential_fingerprint` and `erasure_path`; only aggregate
completion counts are stored in `newsletter_erasure_metrics`.

`newsletter_erasure_controls` stores the global admission pause, the count of
already-admitted confirmation sends, the approved Resend mode, and the current
credential fingerprint. It contains no email addresses, tokens, or contact
IDs.
