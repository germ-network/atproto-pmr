# What summary evidence means

**Status:** implemented contract for GER-3081. Consumer policy thresholds remain out of scope.

## Definition

Summary evidence is a monitor-produced, retained fact about when the monitor first observed declaration material that it accepted and verified. The evidence travels with the summary record so a client can evaluate a newly delivered or changed declaration key without a separate per-DID evidence read.

The record-observation evidence is bound to one exact accepted observation. Its identity includes:

- the declaration subject DID;
- the declaration path (collection and record key);
- the declaration record CID;
- the enclosing signed repository commit CID and `rev` (a TID), plus relevant authority/history identity when available; and
- the key-authority identity for the relevant DID method (PLC operation/branch identity where present; method-specific resolution identity otherwise).

The method-specific authority identity is defined as follows:

- For `did:plc`, bind to the verified PLC operation that authorizes the signing key.
- For `did:web`, bind to the normalized DID-document URL, selected `#atproto` verification-method ID, and public-key fingerprint from a fresh resolution. This means the key appeared in that currently resolved document; it does not prove continuous authority history.

The monitor validates the binding against the accepted record and its proof at ingest. The summary carries canonical identity fields and monitor provenance; clients apply their trust policy to the provenance rather than receiving a duplicate proof chain solely for this evidence. This does not change ordinary client CAR/signature/proof verification. Some identity components may be derived from proof already carried by the accepted record. The representation must not reduce the binding to DID alone or lose the enclosing commit/key/authority relationship.

## Evidence assurance modes

The preferred evidence path is the DID-document authority history needed to establish which key could sign the repository commit, followed by verification of the signed commit and Merkle proof that binds the exact declaration record. For `did:plc`, the authority history includes its verifiable PLC operation history. If that custody path is missing or unavailable, the monitor may be seeded through a deliberately weaker **current-key cross-check** path:

- obtain a fresh authoritative DID document/current signing key using the DID method (a fresh PLC query for `did:plc`; a fresh HTTPS DID document resolution for `did:web`);
- fetch the current declaration through an AppView interface that returns its DID/path and record CID; if the chosen AppView API does not return a CID, it cannot establish the required cross-source binding;
- fetch the declaration's proof CAR from the PDS and verify the commit signature using the freshly resolved current DID key, requiring the CAR to prove that same DID/path/record CID. The verified PDS CAR supplies the enclosing signed commit CID and `rev`; the AppView response is not assumed to provide those commit fields.

This fallback establishes that the monitor independently observed a currently declared key and an AppView declaration corroborated by a PDS proof CAR signed under that key. It does not establish the complete historical custody chain, continuous key authority, or absence of earlier equivocation. It must be labeled as a distinct assurance mode so clients can choose whether to accept it. A cryptographic contradiction or invalid CAR is a rejection, not a reason to downgrade into this fallback; the fallback is for missing or unavailable chain evidence. AppView/PDS disagreement is not accepted as evidence and is treated as a retryable observation failure, since repository replication can lag.

The monitor anchors first-observed age when it first accepts the exact bound state under any permitted assurance mode. Assurance is a separate current assessment: upgrading the same bound state to full-chain assurance changes the assurance value but does not reset the observation-age anchor. The age says how long the monitor has retained that bound state, not how long it has held the current assurance level. Changes to bound identity create new history as usual.

If an exact authority identity disappears and later reappears, the monitor reuses its original first-observed anchor. This means the age records the first retained observation of that exact identity; it does not assert continuous authority during the gap. The monitor must still verify current authorization before accepting it again. A new `did:plc` operation has a distinct identity and therefore a distinct history.

Supporting this fallback for `did:web` requires the monitor to resolve and retain `did:web` DID documents as first-class current-key evidence, not merely store them as unchecked hints. There is no PLC operation log for `did:web`; the authority comes from fresh DID resolution over HTTPS and the declared web domain. A relaxed seed must use fresh PLC state or a freshly resolved `did:web` document, an AppView declaration, and a PDS proof CAR within one bounded seed attempt; stale cached DID documents cannot establish current authority. Exact numeric freshness limits and method-specific validation settings are implementation configuration.

## Observation age

The monitor records an internal server wall-clock time when it first accepts each evidence scope. The time is anchored once to that monitor's system clock and persists across reconnects, rechecks, and downtime. Re-fetching and re-verifying the same identity does not reset its first-observed anchor. In a Cloudflare Worker, the implementation uses the runtime system clock (`Date.now()`); it does not synchronize time itself.

The contract retains two independently bound histories:

- **Commit/version first observed:** when this monitor first accepted the exact enclosing repository commit/version for the bound declaration. Its identity binds the commit/version to the declaration record identity. This supports commit/high-water currentness evaluation such as R83.
- **Anchor key first observed:** when this monitor first accepted the relevant anchor key under the identified DID-method authority/history. Its identity binds the anchor key, authority/history identity, and monitor provenance; it can persist across changing repository commits. This supports anchor-history currentness evaluation such as R71.

Declaration ordering uses the signed repository commit's `rev` TID (the repository logical clock); the declaration record path uses the fixed key `self` and is not itself a TID. The commit CID binds the exact signed commit, while `rev` supplies its ordering value. First-observed age answers a different question: how long this monitor has retained the exact commit/version or anchor identity. At response time, the server can report age as a duration computed from its own clock. It does not send an absolute timestamp for the client to compare against the client's clock. The policy threshold that maps age to a client decision remains separate.

## Server recheck TTL and client countdown

Recheck TTL is separate from first-observed age. It expresses how long until the server should recheck. A successful recheck can renew the TTL while the original first-observed anchor remains unchanged. A response carries a server-computed remaining TTL. To avoid extending the server's deadline, the client subtracts elapsed request time measured with its local monotonic clock before applying its own maximum and starting the countdown. The socket delivery path avoids shared HTTP caching; any future shared-cache path must account for cache age or be disabled. Exact units and wire fields remain implementation details.

The server uses its system wall clock for observation age and controls the recheck TTL. The client does not compare its wall clock with a server timestamp. It subtracts elapsed request time, caps the resulting remaining duration with its own maximum, and counts down using a local monotonic timer. A stuck client timer can prevent local expiry; that is a client-clock limitation, not evidence that the server observation is recent.

The deployment is responsible for system-time synchronization. The public repository does not require NTS or Roughtime. Direct use from a Worker is deferred because the protocols require UDP, which the Workers runtime does not expose as an outbound interface. While a process is running, the monitor compares wall-clock changes with a monotonic timer to detect observable clock discontinuities. On a detected jump, it reports observation age and TTL as unavailable and calls the optional `onClockDiscontinuity` integration hook for an immediate recheck, while retaining the original anchor. The hook must be wired by the summary-serving application; this repository does not currently provide that caller integration. A detected discontinuity remains latched for the lifetime of the process, so age and TTL remain unavailable until restart. Successful content revalidation alone does not restore age; clock continuity or anchor correctness must be re-established independently. Across process restart or downtime, the monitor relies on deployment system-time synchronization; without an external trusted-time source it cannot independently prove clock continuity across that gap.

## Availability

Evidence-binding availability, observation-age availability, and recheck-TTL availability are separate. A verified binding can remain available with its assurance and provenance even when a clock discontinuity makes its age unavailable. TTL can also be unavailable independently. A legacy row or a row whose binding cannot be proven uses unavailable evidence; it has no synthesized identity, assurance, provenance, age, or TTL. Do not reconstruct historical age from:

- client download or completed-read time;
- a PDS-asserted time;
- `SnapshotEntry.observedAtMs`, which is overwritten on settle and quiet refresh;
- `freshAtMs`, which represents later confirmation freshness; or
- PLC operation `createdAt` annotations, which do not establish declaration first-observation.

Each unavailable value is tagged and has no reason field. An unavailable binding carries no assurance or provenance. An unavailable age carries no duration; unavailable TTL carries no duration. Diagnostic causes are outside this contract. Unavailability does not decide whether a client holds sending, retries a read, falls back to another source, or permits an action.

## Monitor provenance and trust

Each available history carries the logical monitor identity: the monitor hostname, normalized as a lowercase IDNA ASCII DNS name without a trailing dot or port. Provenance lets a client apply its own trust policy; it does not, by itself, prove that the monitor is authorized or trusted. No separate clock-sequence identity or cryptographic time attestation is required by this contract.

## Snapshot and delivery invariant

The summary record bytes and their evidence form one observation pair. Both must have the same verified identity. A consumer must never combine a CAR from observation B with evidence from observation A, and it must never attach evidence for a rejected replacement to an older record retained in a cache.

All stable, decision-relevant evidence state participates in summary comparison: binding identity, assurance, availability, provenance, and persisted observation anchors. Elapsed time alone does not create a delta: age and remaining TTL are computed when a record is emitted, and ordinary countdown does not churn deltas. Full reads, deltas, continuation pages, token advancement, and restart preserve the evidence association for the exact bytes the client received. If stored evidence does not match the CAR or summary index, evidence is reported unavailable and is never paired with that record. A legacy token baseline without evidence requires a fresh full read; no historical age is backfilled.

## Concrete examples

1. **Quiet re-confirmation:** The monitor re-fetches and re-verifies the same accepted observation. It updates its latest verification/freshness basis and may renew recheck TTL, but preserves the original first-observed time and the age continues to grow.
2. **Different repository observation:** The declaration CID stays the same while the signed commit/version, key, or branch identity changes. The summary compares the bound evidence identity and reports the corresponding first-observed history when the reviewed binding says it is relevant.
3. **Rejected replacement:** Candidate B fails verification and the monitor retains accepted record A. Evidence for B never describes A. Advancing a token or coverage watermark does not establish that B was accepted.
4. **Clock discontinuity:** The record binding and assurance remain known, but observation age and the TTL basis are unavailable until clock continuity or anchor correctness is re-established independently. Revalidating the CAR does not restore age.
5. **Legacy row:** The record exists but no valid first-observed history was retained. The summary reports explicit unavailable binding evidence; it does not reconstruct age or TTL from the current snapshot’s latest observed or confirmation time.

## Implemented wire and timing choices

- Each summary record has a nested compact CBOR evidence map (`e`): commit CID `c`, `rev` `r`, authority `a`, assurance `s`, monitor hostname `m`, commit age `g`, anchor age `h`, and remaining TTL `t`. PLC authority uses method `p` and operation CID `o`; web authority uses method `w`, document URL `u`, verification-method ID `i`, and key fingerprint `f`. Age and TTL are integer milliseconds; CBOR `null` means explicitly unavailable.
- A seed attempt must finish within 30 seconds. AppView `getRecord` is bounded to 5 seconds and a 64 KiB response. Its CID and URI must match the PDS proof CAR's declaration. AppView requests bypass caches.
- The running process compares wall-clock and monotonic elapsed time with a 5 second discontinuity threshold. On a detected jump, ages and TTLs become unavailable; summary callers can provide `onClockDiscontinuity` to request an immediate source recheck. Restart and downtime continuity relies on deployment system-time synchronization.
- Summary token schema version 1 marks evidence-aware baselines; older baselines receive a full read. The monitor starts a resumable evidence refresh sweep over indexed declarations; legacy rows remain evidence-unavailable until successfully revalidated.
- Consumer policy thresholds that use observation age, including elapsed-window/high-water rules, belong in the client contract. The backend evidence contract does not decide R71/R83 outcomes.
