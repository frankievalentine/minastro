-- Quarantine-safe Resend synchronization state.
-- Every row still present in the legacy outbox is an outstanding operation.
-- The legacy protocol did not durably prove that an unleased row had no
-- in-flight remote mutation, so all rows become uncertain at migration time.

DROP TRIGGER IF EXISTS trg_ns_resend_sync;

CREATE TABLE resend_sync_outbox_v3 (
    subscriber_id       INTEGER PRIMARY KEY REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
    desired_active      INTEGER NOT NULL CHECK (desired_active IN (0, 1)),
    revision            INTEGER NOT NULL DEFAULT 1,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT NOT NULL DEFAULT (datetime('now')),
    state               TEXT NOT NULL CHECK (state IN ('ready', 'running', 'uncertain')),
    lease_token         TEXT,
    lease_expires_at    TEXT,
    claimed_revision    INTEGER,
    last_http_status    INTEGER,
    last_error_code     TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
        (state = 'ready' AND lease_token IS NULL AND lease_expires_at IS NULL AND claimed_revision IS NULL)
        OR
        (state IN ('running', 'uncertain') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND claimed_revision IS NOT NULL)
    )
);

INSERT INTO resend_sync_outbox_v3 (
    subscriber_id,
    desired_active,
    revision,
    attempt_count,
    next_attempt_at,
    state,
    lease_token,
    lease_expires_at,
    claimed_revision,
    last_http_status,
    last_error_code,
    created_at,
    updated_at
)
SELECT
    subscriber_id,
    desired_active,
    revision,
    attempt_count,
    next_attempt_at,
    'uncertain',
    COALESCE(lease_token, lower(hex(randomblob(16)))),
    COALESCE(lease_expires_at, datetime('now')),
    revision,
    last_http_status,
    last_error_code,
    created_at,
    updated_at
FROM resend_sync_outbox;

DROP TABLE resend_sync_outbox;
ALTER TABLE resend_sync_outbox_v3 RENAME TO resend_sync_outbox;

CREATE INDEX idx_resend_sync_ready
    ON resend_sync_outbox(state, next_attempt_at);

CREATE INDEX idx_resend_sync_lease
    ON resend_sync_outbox(state, lease_expires_at);

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
        state,
        lease_token,
        lease_expires_at,
        claimed_revision,
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
        'ready',
        NULL,
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
        attempt_count = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain')
                THEN resend_sync_outbox.attempt_count
            ELSE 0
        END,
        next_attempt_at = datetime('now'),
        state = CASE
            WHEN resend_sync_outbox.state = 'running'
                 AND (resend_sync_outbox.lease_expires_at IS NULL
                      OR datetime(resend_sync_outbox.lease_expires_at) <= datetime('now'))
                THEN 'uncertain'
            WHEN resend_sync_outbox.state IN ('running', 'uncertain')
                THEN resend_sync_outbox.state
            ELSE 'ready'
        END,
        lease_token = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain')
                THEN resend_sync_outbox.lease_token
            ELSE NULL
        END,
        lease_expires_at = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain')
                THEN resend_sync_outbox.lease_expires_at
            ELSE NULL
        END,
        claimed_revision = CASE
            WHEN resend_sync_outbox.state IN ('running', 'uncertain')
                THEN resend_sync_outbox.claimed_revision
            ELSE NULL
        END,
        last_http_status = resend_sync_outbox.last_http_status,
        last_error_code = resend_sync_outbox.last_error_code,
        updated_at = datetime('now');
END;
