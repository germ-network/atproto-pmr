---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Devices can read a DID's signed `did:plc` operation log, or a `did:web` document as a hint.

New in core: `handleDidDocRead` (`GET /pmr/v1/did/{did}`) with its codec (`DID_DOC_READ_KEYS`, `PLC_LOG_ENTRY_KEYS`, `PLC_COVERAGE_KEYS`) and `PlcLogStore`; `parsePlcAuditLog`, `verifyPlcLog`, `appendPlcLogEntry` and `PlcLogError`, which verify a log the way a device does (including a legacy `create` genesis and nullified operations); `fetchPlcAuditLog`. `verifyMultikeySignature`, `encodeDagCbor` and `base32Lower` are now exported from repo-proof internals for them.

The monitor keeps a log for each watched `did:plc` DID: the export stream extends it (an appended operation's signature is checked) or owes a fetch of the directory's audit log, which `drainPlcLogs` fetches and verifies at a bounded rate (`PLC_LOG_DRAIN_BATCH`, default 20 per alarm) before it is stored and published as `plclog:<did>` (`kvPlcLogs`). A stored log confirms the document it renders. `intakePlcEvent` takes an optional `PlcLogIndex`, and `PlcExportEvent` gains `entry`. After a restart of the stream's unbroken run every held log is fetched again, so a large `everyone` deployment spends many alarms re-fetching.
