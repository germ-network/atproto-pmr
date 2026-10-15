-- The block index, written only by MonitorIngest. Not projected or served
-- publicly (no device reads other DIDs' block lists, and serving them would
-- cost): the owner reads their own blocks through the authenticated summary;
-- other DIDs' blocks only answer whether one DID blocks another.

-- Every block of a served graph's owner, plus a non-owner in interest's
-- blocks of registered DIDs. `gen` is the listing generation that last wrote
-- the row; a listing sweeps the blocker's older rows.
CREATE TABLE blocks (
    blocker TEXT NOT NULL,
    rkey TEXT NOT NULL,
    subject TEXT NOT NULL,
    gen INTEGER NOT NULL,
    PRIMARY KEY (blocker, rkey)
);
CREATE INDEX blocks_by_pair ON blocks (blocker, subject);
