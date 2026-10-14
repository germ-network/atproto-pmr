---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Keep a DID document for each watched DID, and let a relay trust it for 24 hours under published export-stream coverage, ten minutes otherwise.

A monitor stores the document its fetches resolve (the record fetch and the refresh's head read) and, for `did:plc` with `PLC_EXPORT_STREAM_URL` set, renders each operation on the export stream into the document the directory serves. Writes are ordered by when the directory held the state they describe. `MonitorIngest` publishes `doc:<did>` to the records store, and `plc:coverage` once the stream's unbroken run is stored with the cursor. The export consumer is the one that already keeps the signing-key cache current: still one socket, one cursor and one decode.

New in core: `renderPlcDocument`, `storedSigningKeyResolver`, `pdsResolutionFromDocument`, `STORED_DID_DOCUMENT_MAX_AGE_MS`, `PLC_COVERAGE_MAX_LAG_MS`, `PlcCoverage`, `StoredSigningKeyResolverDeps`; `fetchDidDocument` and `extractSigningKey` are exported from the fetch module.

New in monitor: `DidDocumentSink`, `FETCH_AS_OF_SKEW_MS`, `PlcDocumentChange`, `IngestDeps.didDocuments`, `FetchedRecord.didDocument`, `FetchedDidDocument`, `FetchHeadRevOptions` (`onDidDocument`, `nowMs`), `FetchRecordOptions.nowMs`. `PlcExportEvent` gains `createdAtMs` and `change`; `intakePlcEvent` takes an optional document sink; `KeyUpdateIndex.advancePlcCursor` and `oweKeyUpdate` take an optional `createdAtMs`.

New in monitor-cloudflare: `kvDidDocuments`, `kvPlcCoverage`. `MonitorIngest` implements `DidDocumentSink`, adds `publishDidDocuments` and `publishPlcCoverage`, and its PLC cursor row also carries the coverage run's start. A subclass that overrides `fetchHeadRev` must pass its document to `recordDidDocument`.
