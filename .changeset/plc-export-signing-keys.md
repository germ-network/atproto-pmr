---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Keep a relay's cached did:plc signing keys current from the PLC directory's export stream.

New optional env var on the monitor: `PLC_EXPORT_STREAM_URL`. Unset, nothing changes except that identity events now owe a cache delete for every watched DID; set, `MonitorIngest` holds a second outbound socket, resumes from a stored `seq` (or the tip), and applies each op for a watched DID to the `sk:` cache. For `did:plc` the stream replaces the Jetstream identity hint, which then covers other DIDs only.

New in monitor: `decodePlcExportFrame`, `intakePlcEvent`, `drainKeyUpdates`, `plcCursorAfterClose`, the `KeyUpdateIndex` and `SigningKeyCacheWriter` interfaces, their `OwedKeyUpdate`, `PlcExportEvent`, `SigningKeyUpdate`, `PlcCursorAction`, `PlcIntakeDecision` and `DrainKeyUpdatesDeps` types, `IngestDeps.keyUpdates`. `MonitorIngest` gains the `KeyUpdateIndex` methods.

New in monitor-cloudflare: `kvSigningKeyCache`, the `sk:<did>` adapter for the relay's cache and the consumer.
