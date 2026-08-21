-- =============================================================================
-- Newsletter: 0001_initial.sql
-- Scope:      newsletter_subscribers table + audit_events table + triggers
-- Migration:  Apply via `bunx wrangler d1 migrations apply NEWSLETTER_DB --local`
--             Remote via `bunx wrangler d1 migrations apply NEWSLETTER_DB --remote`
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. newsletter_subscribers
-- ---------------------------------------------------------------------------
-- Stores every subscriber who has ever submitted the form. Rows are never
-- physically deleted -- status transitions are the source of truth.
--
-- Retention / erasure (GDPR right to erasure):
--   Do NOT DELETE rows. Instead, anonymize PII columns:
--     UPDATE newsletter_subscribers
--     SET email = 'redacted-' || id || '@localhost',
--         name = NULL,
--         confirmation_token_hash = NULL,
--         confirmation_expires_at = NULL,
--         updated_at = datetime('now')
--     WHERE id = ?;
--   The audit_events trail is preserved with an anonymised subscriber_id
--   reference. The subscriber can never be re-identified or re-subscribed.
--
-- Export (GDPR right to data portability):
--   SELECT email, name, status, requested_at, first_confirmed_at, created_at
--   FROM newsletter_subscribers
--   WHERE status = 'active'
--   ORDER BY created_at DESC;
-- ---------------------------------------------------------------------------
CREATE TABLE newsletter_subscribers (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    email                       TEXT    NOT NULL UNIQUE,
    name                        TEXT,
    status                      TEXT    NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'active', 'unsubscribed')),
    -- SHA-256 hash of the one-time confirmation token. NULL once confirmed.
    confirmation_token_hash     TEXT,
    -- ISO-8601 expiration timestamp for the confirmation token (24 h from creation).
    confirmation_expires_at     TEXT,
    -- Stable, recoverable unsubscribe token (raw, not hashed).
    -- Generated once at creation; preserved on resubscribe from unsubscribed.
    -- Stored in plain text so it can be included in unsubscribe links.
    unsubscribe_token           TEXT    NOT NULL UNIQUE,
    -- SHA-256 hash of the unsubscribe token (for lookup without exposing raw token).
    -- ISO-8601 timestamp of the most recent confirmation email send.
    last_confirmation_sent_at   TEXT,
    -- Semver-like string identifying which privacy-policy / consent version
    -- the subscriber agreed to at the time of signup (e.g. "1.0").
    consent_version             TEXT    NOT NULL,
    -- ISO-8601 timestamp of the most recent subscription request (including resends).
    requested_at                TEXT    NOT NULL DEFAULT (datetime('now')),
    -- ISO-8601 timestamp of the first confirmation.
    first_confirmed_at          TEXT,
    -- ISO-8601 timestamp of the most recent confirmation.
    last_confirmed_at           TEXT,
    -- ISO-8601 timestamp of the most recent unsubscription.
    last_unsubscribed_at        TEXT,
    created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ns_status ON newsletter_subscribers(status);
CREATE INDEX idx_ns_created_at ON newsletter_subscribers(created_at);
CREATE INDEX idx_ns_confirm_token_hash ON newsletter_subscribers(confirmation_token_hash);
CREATE INDEX idx_ns_unsubscribe_token ON newsletter_subscribers(unsubscribe_token);

-- ---------------------------------------------------------------------------
-- 2. audit_events
-- ---------------------------------------------------------------------------
-- Immutable append-only log of every state-changing event for a subscriber.
-- Used for compliance, debugging, and analytics.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id   INTEGER NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
    event_type      TEXT    NOT NULL,
    metadata        TEXT,  -- optional JSON blob for extra context
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ae_subscriber ON audit_events(subscriber_id);
CREATE INDEX idx_ae_created_at ON audit_events(created_at);
CREATE INDEX idx_ae_type ON audit_events(event_type);

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------

-- 3a. Audit: log every new subscriber with consent version
CREATE TRIGGER trg_ns_insert_audit
AFTER INSERT ON newsletter_subscribers
FOR EACH ROW
BEGIN
    INSERT INTO audit_events (subscriber_id, event_type, metadata, created_at)
    VALUES (
        NEW.id,
        'subscribed',
        json_object('consent_version', NEW.consent_version),
        datetime('now')
    );
END;

-- 3b. Audit: log every status transition with consent version and previous status
CREATE TRIGGER trg_ns_status_audit
AFTER UPDATE OF status ON newsletter_subscribers
FOR EACH ROW
WHEN OLD.status != NEW.status
BEGIN
    INSERT INTO audit_events (subscriber_id, event_type, metadata, created_at)
    VALUES (
        NEW.id,
        CASE NEW.status
            WHEN 'pending' THEN 'resubscribed'
            WHEN 'active' THEN 'confirmed'
            WHEN 'unsubscribed' THEN 'unsubscribed'
        END,
        json_object(
            'previous_status', OLD.status,
            'consent_version', NEW.consent_version
        ),
        datetime('now')
    );
END;

-- 3c. Auto-update updated_at on any row change
-- SQLite recursive triggers are OFF by default, so this UPDATE will not
-- fire itself recursively.
CREATE TRIGGER trg_ns_updated_at
AFTER UPDATE ON newsletter_subscribers
FOR EACH ROW
BEGIN
    UPDATE newsletter_subscribers SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ---------------------------------------------------------------------------
-- Pending-subscriber retention
-- ---------------------------------------------------------------------------
-- Subscribers who remain in 'pending' status indefinitely (never confirmed)
-- are retained. The 24-hour confirmation_expires_at prevents use of stale
-- tokens, but the row itself is kept so the subscriber can request a new
-- confirmation email (resend) without re-entering their email.
--
-- To purge unconfirmed rows after a 7-day grace period, run a separate
-- scheduled script:
--   DELETE FROM newsletter_subscribers
--   WHERE status = 'pending'
--     AND requested_at < datetime('now', '-7 days');
-- This is OPTIONAL and NOT part of the default migration.
