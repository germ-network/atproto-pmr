---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Seams for a deployment to extend the relay. With none configured, behaviour and encoding are unchanged.

- `ingestAuthenticatedPut` stores a put whose sender the caller has already authenticated, exactly as a verified pair put is stored (admission, pool, quota, replay record), and `handlePairPut` now runs through it. `MessageRef.ext` carries deployment fields, emitted beside `sd`/`dc` on every delivery path; `RESERVED_ENTRY_KEYS` lists the keys it may not use.
- `OwnerDeps.registrationExtension` parses extra registration-create fields (stored whole on every create, so an omitted key is withdrawn), runs `onCommitted` before the `201`, and adds keys to `GET /pmr/v1/registration` through `readFields`.
- `KVDirectory.onRemoved(did, locator)` is raised once per registration removed by replace, retire or deregister.
- `IngestDeps.onSettled` (and `InterestDeps.onSettled`, `MonitorIngest.onSettled`) fires after each verified declaration is stored and with `null` when one is disposed.
- `kvFirehoseCoverage` is exported from the monitor-cloudflare package.
