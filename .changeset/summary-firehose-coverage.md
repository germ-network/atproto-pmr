---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

The owner's summary carries the monitor's coverage: `w`, the earlier of the firehose and PLC covered-through instants in ms (null when either is missing), and `l`, the summary's contacts the monitor has not caught up on (sorted DIDs). Both appear on every `200`, are per response and not part of a stored state, so old decoders ignore them. `SummaryPageDeps` gains `getFirehoseCoverage` and `getPlcCoverage` (wire `kvFirehoseCoverage(env)` and `kvPlcCoverage(env)`; `PLC_EXPORT_STREAM_URL` must stay set or `w` is always null), and the summary reads coverage before the index and any record.

The monitor publishes `firehose:coverage` from its alarm: the stream cursor held back by the oldest owed event, including a fetch applied within the last 60 s, with DIDs owed an event over ten minutes old moved to a lagging list. A stream gap (a cursor older than `JETSTREAM_LOOKBACK_MS` at connect, or a first frame past `JETSTREAM_RESUME_TOLERANCE_MS` after a resume) starts a new run and owes every served declaration. `MonitorIndex` gains `owedGenOf`, and `owe` takes an optional stream time; the ingest object migrates `pending` at construction and adds `applied_recent`.

Fixes a race where an event owed while a fetch was in flight was discharged by that older fetch: every discharge now deletes only the generation the fetch started under.
