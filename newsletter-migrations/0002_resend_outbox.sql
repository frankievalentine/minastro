-- Coalesced Resend Segment synchronization. D1 remains authoritative; this
-- outbox is drained by the Worker cron and never blocks consent endpoints.
CREATE TABLE resend_sync_outbox (
    subscriber_id       INTEGER PRIMARY KEY REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
    desired_active      INTEGER NOT NULL CHECK (desired_active IN (0, 1)),
    revision            INTEGER NOT NULL DEFAULT 1,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT NOT NULL DEFAULT (datetime('now')),
    lease_token         TEXT,
    lease_expires_at    TEXT,
    last_http_status    INTEGER,
    last_error_code     TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_resend_sync_due
    ON resend_sync_outbox(next_attempt_at);

CREATE INDEX idx_resend_sync_lease
    ON resend_sync_outbox(lease_expires_at);

-- Enqueue every existing subscriber. Only active subscribers belong in the
-- Segment; the inactive rows repair stale Segment membership after migration.
INSERT INTO resend_sync_outbox (subscriber_id, desired_active, next_attempt_at)
SELECT id, CASE WHEN status = 'active' THEN 1 ELSE 0 END, datetime('now')
FROM newsletter_subscribers;

CREATE TRIGGER trg_ns_resend_sync
AFTER UPDATE OF status ON newsletter_subscribers
FOR EACH ROW
WHEN OLD.status != NEW.status
BEGIN
    INSERT INTO resend_sync_outbox (
        subscriber_id,
        desired_active,
        revision,
        attempt_count,
        next_attempt_at,
        lease_token,
        lease_expires_at,
        last_http_status,
        last_error_code,
        created_at,
        updated_at
    )
    VALUES (
        NEW.id,
        CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END,
        1,
        0,
        datetime('now'),
        NULL,
        NULL,
        NULL,
        NULL,
        datetime('now'),
        datetime('now')
    )
    ON CONFLICT(subscriber_id) DO UPDATE SET
        desired_active = excluded.desired_active,
        revision = resend_sync_outbox.revision + 1,
        attempt_count = 0,
        next_attempt_at = datetime('now'),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_http_status = NULL,
        last_error_code = NULL,
        updated_at = datetime('now');
END;
