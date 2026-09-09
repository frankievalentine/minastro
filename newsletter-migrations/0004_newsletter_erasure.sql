-- Cross-system newsletter erasure state.
-- This migration rebuilds the three related tables so the subscriber status
-- and outbox ownership checks remain enforced by SQLite constraints.

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS trg_ns_resend_sync;
DROP TRIGGER IF EXISTS trg_ns_status_audit;
DROP TRIGGER IF EXISTS trg_ns_insert_audit;
DROP TRIGGER IF EXISTS trg_ns_updated_at;
DROP INDEX IF EXISTS idx_ns_status;
DROP INDEX IF EXISTS idx_ns_created_at;
DROP INDEX IF EXISTS idx_ns_confirm_token_hash;
DROP INDEX IF EXISTS idx_ns_unsubscribe_token;
DROP INDEX IF EXISTS idx_ae_subscriber;
DROP INDEX IF EXISTS idx_ae_created_at;
DROP INDEX IF EXISTS idx_ae_type;
DROP INDEX IF EXISTS idx_resend_sync_ready;
DROP INDEX IF EXISTS idx_resend_sync_lease;

ALTER TABLE newsletter_subscribers RENAME TO newsletter_subscribers_v3;
ALTER TABLE audit_events RENAME TO audit_events_v3;
ALTER TABLE resend_sync_outbox RENAME TO resend_sync_outbox_v3;

CREATE TABLE newsletter_subscribers (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    email                       TEXT    NOT NULL UNIQUE,
    name                        TEXT,
    status                      TEXT    NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'active', 'unsubscribed', 'erasure_pending')),
    confirmation_token_hash     TEXT,
    confirmation_expires_at    TEXT,
    confirmation_admitted      INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_admitted IN (0, 1)),
    confirmation_admission_id   TEXT UNIQUE,
    unsubscribe_token           TEXT    NOT NULL UNIQUE,
    last_confirmation_sent_at   TEXT,
    consent_version             TEXT    NOT NULL,
    requested_at                TEXT    NOT NULL DEFAULT (datetime('now')),
    first_confirmed_at          TEXT,
    last_confirmed_at           TEXT,
    last_unsubscribed_at        TEXT,
    created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK ((confirmation_admitted = 0 AND confirmation_admission_id IS NULL)
        OR (confirmation_admitted = 1 AND confirmation_admission_id IS NOT NULL))
);

INSERT INTO newsletter_subscribers (
    id, email, name, status, confirmation_token_hash,
    confirmation_admitted, confirmation_admission_id, confirmation_expires_at, unsubscribe_token, last_confirmation_sent_at,
    consent_version, requested_at, first_confirmed_at, last_confirmed_at,
    last_unsubscribed_at, created_at, updated_at
)
SELECT
    id, email, name, status, confirmation_token_hash,
    0, NULL, confirmation_expires_at, unsubscribe_token, last_confirmation_sent_at,
    consent_version, requested_at, first_confirmed_at, last_confirmed_at,
    last_unsubscribed_at, created_at, updated_at
FROM newsletter_subscribers_v3;

CREATE INDEX idx_ns_status ON newsletter_subscribers(status);
CREATE INDEX idx_ns_created_at ON newsletter_subscribers(created_at);
CREATE INDEX idx_ns_confirm_token_hash ON newsletter_subscribers(confirmation_token_hash);
CREATE INDEX idx_ns_unsubscribe_token ON newsletter_subscribers(unsubscribe_token);

CREATE TABLE audit_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id   INTEGER NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
    event_type      TEXT    NOT NULL,
    metadata        TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO audit_events (id, subscriber_id, event_type, metadata, created_at)
SELECT id, subscriber_id, event_type, metadata, created_at
FROM audit_events_v3;

CREATE INDEX idx_ae_subscriber ON audit_events(subscriber_id);
CREATE INDEX idx_ae_created_at ON audit_events(created_at);
CREATE INDEX idx_ae_type ON audit_events(event_type);

CREATE TABLE resend_sync_outbox (
    subscriber_id       INTEGER PRIMARY KEY REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
    operation            TEXT NOT NULL DEFAULT 'sync' CHECK (operation IN ('sync', 'erase')),
    desired_active      INTEGER NOT NULL CHECK (desired_active IN (0, 1)),
    revision            INTEGER NOT NULL DEFAULT 1,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT NOT NULL DEFAULT (datetime('now')),
    state               TEXT NOT NULL CHECK (state IN ('ready', 'running', 'uncertain', 'remote_deleted')),
    lease_token         TEXT,
    lease_expires_at    TEXT,
    claimed_operation   TEXT CHECK (claimed_operation IS NULL OR claimed_operation IN ('sync', 'erase')),
    claimed_revision    INTEGER,
    resend_contact_id   TEXT,
    resend_credential_fingerprint TEXT,
    erasure_path        TEXT NOT NULL DEFAULT 'resend' CHECK (erasure_path IN ('resend', 'local_only')),
    remote_state        TEXT NOT NULL DEFAULT 'none' CHECK (remote_state IN ('none', 'remote_deleted', 'initial_absent', 'local_only')),
    last_http_status    INTEGER,
    last_error_code     TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
        (state IN ('ready', 'remote_deleted') AND lease_token IS NULL AND lease_expires_at IS NULL AND claimed_operation IS NULL AND claimed_revision IS NULL)
        OR
        (state IN ('running', 'uncertain') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND claimed_operation IS NOT NULL AND claimed_revision IS NOT NULL)
    ),
    CHECK (remote_state IN ('none', 'local_only') OR operation = 'erase'),
    CHECK (state != 'remote_deleted' OR (operation = 'erase' AND remote_state IN ('remote_deleted', 'initial_absent', 'local_only'))),
    CHECK (erasure_path = 'local_only' OR operation = 'sync' OR resend_credential_fingerprint IS NOT NULL OR remote_state = 'none')
);

INSERT INTO resend_sync_outbox (
    subscriber_id, operation, desired_active, revision, attempt_count,
    next_attempt_at, state, lease_token, lease_expires_at,
    claimed_operation, claimed_revision, resend_contact_id, resend_credential_fingerprint,
    erasure_path, remote_state,
    last_http_status, last_error_code, created_at, updated_at
)
SELECT
    subscriber_id, 'sync', desired_active, revision, attempt_count,
    next_attempt_at, state, lease_token, lease_expires_at,
    CASE WHEN state IN ('running', 'uncertain') THEN 'sync' ELSE NULL END,
    claimed_revision, NULL, NULL, 'resend', 'none', last_http_status, last_error_code,
    created_at, updated_at
FROM resend_sync_outbox_v3;

CREATE INDEX idx_resend_sync_ready
    ON resend_sync_outbox(state, next_attempt_at);

CREATE INDEX idx_resend_sync_lease
    ON resend_sync_outbox(state, lease_expires_at);

CREATE INDEX idx_resend_erase_contact
    ON resend_sync_outbox(operation, resend_contact_id);

CREATE INDEX idx_resend_erase_fingerprint
    ON resend_sync_outbox(operation, resend_credential_fingerprint);

CREATE TABLE newsletter_erasure_controls (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    admission_state             TEXT NOT NULL CHECK (admission_state IN ('open', 'paused')),
    active_confirmation_sends   INTEGER NOT NULL DEFAULT 0 CHECK (active_confirmation_sends >= 0),
    resend_mode                 TEXT NOT NULL CHECK (resend_mode IN ('unverified', 'resend', 'local_only')),
    credential_fingerprint      TEXT,
    rebind_revision             INTEGER NOT NULL DEFAULT 0,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO newsletter_erasure_controls (id, admission_state, resend_mode)
VALUES (1, 'open', 'unverified');

CREATE TABLE newsletter_erasure_metrics (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    completed_count     INTEGER NOT NULL DEFAULT 0,
    last_completed_at   TEXT
);

INSERT INTO newsletter_erasure_metrics (id, completed_count)
VALUES (1, 0);

DROP TABLE resend_sync_outbox_v3;
DROP TABLE audit_events_v3;
DROP TABLE newsletter_subscribers_v3;

CREATE TRIGGER trg_ns_insert_audit
AFTER INSERT ON newsletter_subscribers
FOR EACH ROW
BEGIN
    INSERT INTO audit_events (subscriber_id, event_type, metadata, created_at)
    VALUES (NEW.id, 'subscribed', json_object('consent_version', NEW.consent_version), datetime('now'));
END;

CREATE TRIGGER trg_ns_confirmation_admitted_insert
AFTER INSERT ON newsletter_subscribers
FOR EACH ROW
WHEN NEW.confirmation_admitted = 1
BEGIN
    UPDATE newsletter_erasure_controls
    SET active_confirmation_sends = active_confirmation_sends + 1,
        updated_at = datetime('now')
    WHERE id = 1;
END;

CREATE TRIGGER trg_ns_confirmation_admitted_update
AFTER UPDATE OF confirmation_admitted ON newsletter_subscribers
FOR EACH ROW
WHEN OLD.confirmation_admitted = 0 AND NEW.confirmation_admitted = 1
BEGIN
    UPDATE newsletter_erasure_controls
    SET active_confirmation_sends = active_confirmation_sends + 1,
        updated_at = datetime('now')
    WHERE id = 1;
END;

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
            WHEN 'erasure_pending' THEN 'erasure_requested'
        END,
        json_object('previous_status', OLD.status, 'consent_version', NEW.consent_version),
        datetime('now')
    );
END;

CREATE TRIGGER trg_ns_updated_at
AFTER UPDATE ON newsletter_subscribers
FOR EACH ROW
BEGIN
    UPDATE newsletter_subscribers SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_ns_resend_sync
AFTER UPDATE OF status ON newsletter_subscribers
FOR EACH ROW
WHEN OLD.status != NEW.status
BEGIN
    INSERT INTO resend_sync_outbox (
        subscriber_id, operation, desired_active, revision, attempt_count,
        next_attempt_at, state, lease_token, lease_expires_at,
        claimed_operation, claimed_revision, resend_contact_id,
        resend_credential_fingerprint, erasure_path, remote_state,
        last_http_status, last_error_code, created_at, updated_at
    )
    VALUES (
        NEW.id,
        CASE WHEN NEW.status = 'erasure_pending' THEN 'erase' ELSE 'sync' END,
        CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END,
        1, 0, datetime('now'), 'ready', NULL, NULL, NULL, NULL, NULL, NULL,
        'resend', 'none', NULL, NULL, datetime('now'), datetime('now')
    )
    ON CONFLICT(subscriber_id) DO UPDATE SET
        operation = CASE
            WHEN resend_sync_outbox.operation = 'erase' OR excluded.operation = 'erase' THEN 'erase'
            ELSE 'sync'
        END,
        desired_active = CASE
            WHEN resend_sync_outbox.operation = 'erase' OR excluded.operation = 'erase' THEN 0
            ELSE excluded.desired_active
        END,
        revision = resend_sync_outbox.revision + 1,
        attempt_count = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.attempt_count
            ELSE 0
        END,
        next_attempt_at = datetime('now'),
        state = CASE
            WHEN resend_sync_outbox.state = 'remote_deleted' THEN 'remote_deleted'
            WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.state
            ELSE 'ready'
        END,
        lease_token = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.lease_token
            ELSE NULL
        END,
        lease_expires_at = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.lease_expires_at
            ELSE NULL
        END,
        claimed_operation = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.claimed_operation
            ELSE NULL
        END,
        claimed_revision = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.claimed_revision
            ELSE NULL
        END,
        resend_contact_id = CASE
            WHEN resend_sync_outbox.operation = 'erase' OR excluded.operation = 'erase' THEN resend_sync_outbox.resend_contact_id
            ELSE NULL
        END,
        resend_credential_fingerprint = CASE
            WHEN resend_sync_outbox.operation = 'erase' OR excluded.operation = 'erase' THEN resend_sync_outbox.resend_credential_fingerprint
            ELSE NULL
        END,
        erasure_path = CASE
            WHEN resend_sync_outbox.operation = 'erase' OR excluded.operation = 'erase' THEN resend_sync_outbox.erasure_path
            ELSE 'resend'
        END,
        remote_state = CASE
            WHEN resend_sync_outbox.operation = 'erase' OR excluded.operation = 'erase' THEN resend_sync_outbox.remote_state
            ELSE 'none'
        END,
        last_http_status = resend_sync_outbox.last_http_status,
        last_error_code = resend_sync_outbox.last_error_code,
        updated_at = datetime('now');
END;

PRAGMA foreign_keys = ON;
