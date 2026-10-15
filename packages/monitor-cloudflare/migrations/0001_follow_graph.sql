-- The follow-edge index, written only by MonitorIngest and read by the owner
-- graph and block reads. Edges are hints: a device verifies one against the follower's
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

-- Declaration holders: an owner's graph keeps only edges whose other party is one.
CREATE TABLE graph_holders (
    did TEXT PRIMARY KEY
);
