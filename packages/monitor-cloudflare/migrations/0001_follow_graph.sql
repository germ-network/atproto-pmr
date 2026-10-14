-- The follow-edge index, written only by MonitorIngest and read by the read
-- routes. Edges are hints: a device verifies one against the follower's
-- signed record before relying on it.

-- Every follow of a served graph's owner, plus mutual hints: a non-owner in
-- interest following a registered DID. `gen` is the listing generation that
-- last wrote the row; a listing sweeps the follower's older rows.
CREATE TABLE follows (
    follower TEXT NOT NULL,
    rkey TEXT NOT NULL,
    subject TEXT NOT NULL,
    gen INTEGER NOT NULL,
    PRIMARY KEY (follower, rkey)
);
CREATE INDEX follows_subject ON follows (subject);

-- DIDs whose graphs are served.
CREATE TABLE graph_owners (
    did TEXT PRIMARY KEY
);

-- The allow list, for a read route's membership check.
CREATE TABLE interest (
    did TEXT PRIMARY KEY,
    registered INTEGER NOT NULL DEFAULT 0
);

-- Declaration holders: reads return only edges whose other party is one.
CREATE TABLE graph_holders (
    did TEXT PRIMARY KEY
);

-- Whose projection is stale, in order; read at least once by seq cursor and
-- pruned by age.
CREATE TABLE graph_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    did TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (
        reason IN ('following', 'followers', 'holder-add', 'holder-remove', 'served-add', 'served-remove')
    ),
    at_ms INTEGER NOT NULL
);
CREATE INDEX graph_changes_at ON graph_changes (at_ms);
