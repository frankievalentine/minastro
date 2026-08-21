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
- Status lifecycle: `pending` -> `active` -> `unsubscribed`
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
bindings**. They are not included in the active `wrangler.jsonc` by default.
See `wrangler.newsletter.jsonc.example` for the full shape.

| Binding | Type | Purpose |
|---|---|---|
| `NEWSLETTER_DB` | D1 database | Subscriber storage and audit log. Separate from the main EmDash `DB` to keep concerns isolated. |
| `NEWSLETTER_EMAIL` | Email Sending (`send_email`) | Transactional email delivery (confirmation emails). Configured with `allowed_sender_addresses`. |
| `NEWSLETTER_SUBSCRIBE_LIMITER` | Rate Limiter (`ratelimits`) | Per-IP rate limiting on the subscribe endpoint (5 requests per 60 seconds). |

**All three bindings are required when newsletter is enabled.** If any binding
is missing, the subscribe endpoint returns 503. Turnstile and the rate limiter
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

Run `bun run cloudflare:setup` after provisioning the core site. The command offers an opt-in newsletter phase that creates `NEWSLETTER_DB`, writes the D1, Email Sending, and rate-limit bindings, applies the remote migration, stores `TURNSTILE_SECRET_KEY` and the export token through Wrangler, writes the public Turnstile configuration to `src/site.config.ts`, enables the newsletter, and deploys.

Before accepting that phase, complete these account-level prerequisites:

1. Onboard and verify the sender domain in Cloudflare Email Sending, including its required DNS records.
2. Create a Turnstile widget for the newsletter hostname and have its public site key and private secret ready. The command prompts for the secret directly through Wrangler and never writes it to the repository.
3. Obtain a positive Cloudflare Workers Rate Limiting namespace ID for `NEWSLETTER_SUBSCRIBE_LIMITER`.

The setup command sends only double-opt-in confirmation emails. It does not configure or send bulk newsletter campaigns. Optional Resend synchronization places confirmed subscribers in a Resend Segment; create and send Broadcasts in Resend.

### Local configuration is not bindings

`.dev.vars` stores local secret values only. It does **not** create the D1,
Email Sending, or Rate Limiting bindings required by the newsletter. For a
full local flow, configure those bindings in `wrangler.jsonc` (or use the
automated setup flow) and run the Worker with Wrangler. The public newsletter
page intentionally remains visible in its disabled state until all production
requirements are configured.

### Manual fallback

Use the following sections only when the automated setup flow cannot be used.
They describe the same bindings and migrations that `cloudflare:setup` applies.

### 1. Create the D1 database

```bash
bunx wrangler d1 create minastro-newsletter
```

Copy the returned `database_id` and add it to your wrangler config alongside
the existing `DB` binding:

```jsonc
"d1_databases": [
  { "binding": "DB",           "database_name": "minastro",              "database_id": "<existing-id>" },
  { "binding": "NEWSLETTER_DB","database_name": "minastro-newsletter",   "database_id": "<new-id>", "migrations_dir": "newsletter-migrations" }
]
```

### 2. Apply the migration

**Important**: Bindings must be configured in `wrangler.jsonc` **before**
running the migration. The `d1 migrations apply` command resolves the
database via the binding name in your config. Without the binding in place,
the command will fail.

The migration uses Wrangler's `d1 migrations` system (not `d1 execute`).
The `migrations_dir` is set to `newsletter-migrations` inside the
`NEWSLETTER_DB` database entry.

```bash
# Apply locally (uses local D1 data via Wrangler dev)
bunx wrangler d1 migrations apply NEWSLETTER_DB --local

# Apply to production
bunx wrangler d1 migrations apply NEWSLETTER_DB --remote
```

### 3. Set up Email Sending

Cloudflare Email Sending requires a **Workers Paid** plan (the free plan does
not include the `send_email` binding). It is designed for **transactional**
email only -- not for bulk campaigns.

1. Go to the [Cloudflare Dashboard -> Email -> Email Sending](https://dash.cloudflare.com/?to=/:account/email/sending).
2. Add and verify your sending domain (e.g. `newsletter.your-domain.com` or
   `your-domain.com`). This involves adding DNS TXT records (SPF, DKIM, DMARC).
3. Once verified, add the `send_email` binding to your wrangler config:

```jsonc
"send_email": [
  { "name": "NEWSLETTER_EMAIL", "remote": true, "allowed_sender_addresses": ["newsletter@your-domain.com"] }
]
```

The `remote: true` flag tells Wrangler to send real email even when running
under `wrangler dev`. This is necessary because Cloudflare Email Sending has
no local emulator -- without `remote: true`, `wrangler dev` would silently
drop all outbound email. Once the adopter has completed the onboarding steps
above (verified sending domain, configured bindings), `wrangler dev` will
send real confirmation emails to the addresses provided.

The `allowed_sender_addresses` array specifies which `from` addresses the
binding is allowed to use. The `senderAddress` in `site.config.ts` must match
one of these addresses.

### 4. Create a Turnstile widget

1. Go to the [Cloudflare Dashboard -> Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile).
2. Create a new widget for your domain.
3. Copy the **Site Key** (public) into `site.config.ts` as `turnstileSiteKey`.
4. Copy the **Secret Key** and set it as a secret:

```bash
bunx wrangler secret put TURNSTILE_SECRET_KEY
```

### 5. Set the consent version

If you have a privacy policy, set `consentVersion` in `site.config.ts` to
match the version your policy was at when you launched. Bump it whenever
the policy changes materially.

---

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

- **Subscriber rows are never deleted.** Status transitions (`active` ->
  `unsubscribed`) are the source of truth. This prevents accidental
  re-subscription of previously unsubscribed users and maintains the audit
  trail.
- **Audit events are append-only.** No rows are ever modified or deleted
  from `audit_events`.
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
- **Right to erasure (GDPR)**: Do NOT delete rows. Instead, anonymize PII
  columns with a placeholder email:
  ```sql
  UPDATE newsletter_subscribers
  SET email = 'redacted-' || id || '@localhost',
      name = NULL,
      confirmation_token_hash = NULL,
      confirmation_expires_at = NULL,
      updated_at = datetime('now')
  WHERE id = ?;
  ```
  The audit trail is preserved with an anonymised `subscriber_id` reference.
  The subscriber can never be re-identified or re-subscribed.
- **Right to data portability (GDPR)**:
  ```sql
  SELECT email, name, status, requested_at, first_confirmed_at, created_at
  FROM newsletter_subscribers
  WHERE status = 'active'
  ORDER BY created_at DESC;
  ```

### Rate limiting

The subscribe endpoint is rate-limited per IP via the
`NEWSLETTER_SUBSCRIBE_LIMITER` Rate Limiting binding (configured at 5 requests
per 60 seconds in the example config). When the limit is exceeded, the
endpoint returns a generic 429 response. The rate limiter binding is
**required** when newsletter is enabled -- if not configured, the endpoint
returns 503.

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
- Resend API failures retry with backoff and never affect confirmation or unsubscribe responses.

The setup command prompts for `RESEND_SEGMENT_ID` and stores `RESEND_API_KEY` as a Worker secret. Resend currently requires a full-access key for contact operations; use a dedicated Resend account if that scope is unacceptable.

Create and send Broadcasts in the Resend dashboard, targeting this Segment. Do not target all contacts. Resend owns Broadcast unsubscribe headers and global suppression; this integration deliberately does not clear a contact's global Resend unsubscribe state.

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
| `status` | TEXT | `pending` / `active` / `unsubscribed` |
| `confirmation_token_hash` | TEXT | SHA-256 hash, nullable (null after confirm) |
| `confirmation_expires_at` | TEXT | ISO-8601, 24 h from creation |
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
