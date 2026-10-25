# PMR public permission-recency source contract

## Goals

Give ContactsManager one honest upstream ordering value for mutual permission recency, available in held summary reads without a network lookup per contact. The value is for display ordering only.

## Detailed scope

- In: one public aggregate timestamp; same semantics on the public A-can-message-B response and the held owner-summary verdict; exact source inputs, record selection, unknown behavior, delta/token/page behavior, and release dependency order.
- Out: raw timestamp tuple disclosure; trust, currency, send, or delivery policy; device-side follower-graph reconstruction; per-row fetching; changes to the released evidence contract unless separately reviewed under GER-3081.

## Acceptance

- The public result and summary verdict expose only `permissionRecencyAtMs: number | null` (Int64 on clients), an absolute Unix epoch timestamp in milliseconds.
- For a mutual pair, the value is `max(messaging-key first-seen date, A→B follow-record TID date, B→A follow-record TID date)`. Higher is newer.
- `null` means no complete valid tuple is available. Clients keep the contact and treat it as unknown/unranked; they do not synthesize a timestamp.
- A recency-only change is a summary verdict change and is returned in a delta, even if verdict and mutuality did not change.
- Full reads, delta pages, and each token-named delivered baseline preserve the aggregate. A baseline without the new schema/value is replaced by a full read.
- Contract names the exact verified declaration messaging-key identity. Repository signing-key history is not relabeled as messaging-key history.

## Constraints and decisions

- Mark selected a public aggregate on 2026-10-24 because public inputs are acceptable and the client should be easy to implement. Raw component fields are not approved.
- Mark accepted follow-record TID timestamps across sources as approximate ordering hints. Decode by removing the low 10 clock-ID bits, convert the Unix-microsecond timestamp component to milliseconds, and ignore the clock ID for chronology. Cross-source clock skew, monotonic adjustments, and account-controlled values are accepted for this display-only purpose.
- Mark confirmed on 2026-10-24 that when a direction has multiple active follow records, the newest active record rkey TID is the directional hint; for an update under the same rkey, continue to use that unchanged rkey TID, not the new repo `rev`.
- The follow-record `rkey` itself is the accepted TID hint. A content update under the same rkey keeps the same hint; deletion removes that active row; a later recreation contributes its new rkey's hint. This does not preserve a deleted edge's old follow date.
- Mark confirmed on 2026-10-24 that if any active duplicate rkey is malformed, that direction is unknown; an invalid row could be newer than the decodable rows.
- A missing or invalid current directional TID, or unavailable/mismatched messaging-key first-seen history, makes the aggregate `null`. Do not use local completion/currentAsOf, snapshot refresh, declaration record TID, repository commit age, or repository signing-key anchor age as substitutes.
- The aggregate is not authority, evidence currency, or permission-to-send. Existing `SummaryEvidence` remains its separate trust/currency contract.

## Source and delivery contract

The shared aggregate helper and interface vocabulary are in [`permission-recency.ts`](../../packages/core/src/permission-recency.ts). The source property is `permissionRecencyAtMs`; CBOR map key is `t` in both verdict maps. This key was unassigned in the released can-message map (`p` already means pending policies).

Example decoded public can-message map (actual protocol remains deterministic CBOR):

```json
{
  "v": "yes",
  "a": ["bsky-follows"],
  "t": 1792867200123
}
```

An unavailable example is `"t": null`. The held owner-summary row carries the same nullable field beside `did`, `verdict`, and `mutual`. The public can-message result may carry null when the full mutual recency tuple is unavailable or inapplicable; the field never asserts why.

In the current source, `FollowEdgeStore` already returns follower/rkey/subject and the monitor's D1 `follows` index retains rkey. But `ownerGraph()` currently reduces those rows to DID sets and `buildSummaryIndex()` receives only `{did, mutual}`, so the directional TID hints are lost before summary verdict construction. The implementation seam must parse rkeys and preserve the two directional maximum timestamps before/alongside that dedup (for example as private fields on each internal owner-graph edge); don't expose those raw directional fields on the public wire. The public can-message path must use the same backend-side batched graph source for both directions. Do not add device graph reconstruction or per-row device fetches.

Parse rkey as an [AT Protocol TID](https://atproto.com/specs/tid) for the accepted hint; do not substitute the signed repository `rev`. Require the 13-character lowercase base32-sortable syntax, the restricted first character, and the 53-bit microsecond timestamp range beneath the zero top bit before converting to milliseconds. A same-rkey content update therefore keeps the hint. A delete removes that active row; recreation contributes its current rkey. For duplicate active rows for the same ordered pair, choose the maximum decoded rkey TID timestamp. If any active rkey cannot be decoded, that direction is unavailable because an invalid row could be the newest; the aggregate is null.

There is no additional as-of timestamp field: the aggregate is an absolute Unix-millisecond event-time hint, not an age. Directional rows are read from one owner-graph snapshot; declaration-key history is read from held snapshot metadata during the same summary build. The current backend does not provide a transaction spanning graph D1 and held snapshot/history stores, so the sources are best-effort sampled during that build. Cross-source clock/order differences are an accepted ranking limitation. A summary response's changed verdicts and returned token refer to that build; verdict changes are not spread across record pages, and the returned token holds the row values from the response. Later polls may carry newer values as deltas.

`anchorAgeMs` in released v0.2.0 is derived from `anchorFirstObservedAtMs`; the anchor identity is `anchorHistoryId(did, verifiedWith, authority)`. `verifiedWith` is the repository signing key. Mark approved a separate `currentKey` history for ranking on 2026-10-25; do not silently alter released evidence meaning.

The actual declaration field is `currentKey` (`packages/core/src/declaration.ts`); it is a validated Ed25519 anchor key from the accepted declaration CAR. Ranking history is keyed by DID plus a canonical fingerprint of that key and recorded only after accepting the exact declaration under its repository proof. History survives declaration record updates and repository signer/authority rotations, and preserves known observations if a key returns after a different key. Each timestamp row retains declaration record/commit and verification provenance. It uses a distinct table from released repo-signer `anchorAgeMs` history.

The v0.2.0 store has no such `currentKey` history. Mark chose the safe behavior: legacy/current keys with no authentic history remain unavailable, including a key first encountered after upgrade. The tracker writes a durable unknown sentinel for such keys; a later key rotation observed in an accepted declaration CAR starts history for the newly observed key, and the first observation is bound to that record CID, commit CID, `rev`, and repo verification key. Previously seen unknown keys remain unknown if they return. History is a separate table and survives declaration changes and repository signer/authority rotations. The full aggregate remains null rather than substitute `currentAsOf`, declaration TID, repo `rev`, or repo-signer age.

The summary already carries per-contact `SummaryVerdict[]`, compares verdict bytes and mutuality when diffing, returns all changed verdict rows with each response page, and persists the index state named by the returned token. Add the aggregate to that held verdict state and compare it during diffing. A change to only the timestamp must emit that peer's verdict delta. Dropped verdicts remove the entire peer value. Add a distinct server-side `permissionRecencySchema: 1` marker to `SummaryIndex`; an old token baseline without that marker must trigger a full response, even if current values happen to be null. Do not reuse `evidenceSchema`, which versions trust evidence separately. Client persistence also needs a versioned baseline format bump from its existing v2 and token-atomic application; the client owners select the target version. Summary `w` (covered-through milliseconds) and `l` (lagging DIDs) are per-response coverage values, not persisted owner-summary fields. Clients that retain coverage must commit it with the token and held state in their own atomic baseline; this backend aggregate does not synthesize or persist coverage.

## Version and release sequence

Exact planning source pin: `atproto-pmr` released v0.2.0 source at `22dbd04197df0472fa1a680e4e563bf5dbe01684` (origin/main in the assigned worktree). It does not contain this aggregate. Do not claim deployed availability from this artifact.

Required dependency sequence: `atproto-pmr` backend API + held-summary delta/token change → existing `germ-atproto-pmr-client` PR #29 owner adds decoding and token-atomic value persistence/schema migration → `germ-atproto-client` owner passes through accepted held values without changing currency policy → Core ContactsManager adapters → app adoption. Existing pending release batching may combine packages after their reviewed pins align. Backend field addition requires a minor package release; client baseline versioning/reset/full-read behavior must be implemented before relying on recency-only deltas. Wrapper repin and deployment are separate actions and approvals.

## Plan

1. Add separate `currentKey` history keyed by DID and canonical validated key fingerprint. Preserve unknown sentinels for legacy keys; start a timestamp only from a verified post-tracker key transition. Any trust/evidence correction remains separately reviewed and linked.
2. Confirm this public type, CBOR field key, complete-tuple null behavior, and owner-summary transport with the existing 3077/3078/2880/3067 owners.
3. After explicit plan approval, implement one private directional-hint seam that retains the maximum active rkey TID before `ownerGraph()` deduplicates to DID/mutual, then use that same backend source to enrich public can-message and held summary verdicts. Keep the public representation aggregate-only. Add ordinary contract fixtures for same-rkey updates, deletion/recreation, duplicates, invalid/missing values, best-effort cross-store sampling, and delta-only recency changes.
4. Validate via normal package typecheck and contract examples; then hand exact source/version pins to downstream owners. No publication, wrapper deployment, or release is included here.

## Open decisions

- Mark approved a separate `currentKey` history identity, exact accepted-declaration binding, rotation/reappearance behavior, and safe legacy unknown handling on 2026-10-25. Until an authentic first-seen value is available, the aggregate stays null; the current repository signer `anchorAgeMs` is not an acceptable substitute.
- GER-3078 confirmed no extra rank field is needed in its accepted-content projection: keep `permissionRecencyAtMs` on the PMR contact/verdict row, and persist that protocol baseline with accepted-content state in the same `SummaryStateStorage` atomic update. GER-3077 confirmed the nullable millisecond value and will preserve other summary values/token when CBOR key `t` is absent, null, or malformed.
- Exact package versions and source release pins depend on the reviewed backend change and existing pending release train; no versions are assigned here.

## Compiling artifacts

- `packages/core/src/permission-recency.ts` — production tuple aggregation helper and typed public/held shapes.
- `packages/core/test/permission-recency.spec.ts` — ordinary Core unit examples for the complete max, missing input, and invalid input behavior.
- `docs/planning/permission-recency-contract.md` — plan, wire example, provenance, delivery, migration, release pins, and ranked unknown behavior.

## Validation status

Validated locally on 2026-10-25 with Node v24.14.1 and pnpm 10.33.0. `pnpm typecheck` passes across all four packages. Full package suites pass: Core 875 tests, monitor 429 tests, monitor-cloudflare 618 tests, and cloudflare 218 tests (2,140 total). `git diff --check` passes. Regression coverage exercises the real declaration verifier and KV/SQLite history lifecycle (unknown first observation, unrotated legacy snapshot, verified rotation, return to unknown/tracked keys, and forgetting), plus request-side batched D1/KV reads for a non-owner sender holder. Cloudflare tests require loopback access for the local test runtime.

The subsequent TID syntax/range correction passed the Core typecheck and 47 focused tests across owner-graph, permission-recency, and summary-verdicts. It rejects invalid first characters and timestamps outside the 53-bit microsecond field, including malformed active duplicates in either input order.

Public can-message recency uses `d1PermissionRecencyReader` with the request's D1 session and batched KV snapshot metadata; it does not read through MonitorIngest. The held-summary path retains its existing batched backend graph/metadata reads. The wrapper integration must use this source commit until a reviewed package release is available; no release or deployment is implied by local validation.

## Fingerprint-format upgrade

The prior implementation wrote raw encoded `COSE_Key` hex identities; the canonical identity is SHA-256 of the validated canonical key encoding. Settling normalizes prior snapshot metadata before comparing identities. History reads migrate matching raw identities atomically and lazily per DID, preserving unknown sentinels and the earliest tracked observation together with its complete original provenance. If both encodings have conflicting entries, an unknown sentinel takes precedence, because a timestamp must not override evidence that first-seen is unavailable.

The writer keeps both a canonical history identity and a raw compatibility alias, including for newly observed rotations. Thus a rollback to the prior raw-identity writer can find histories already handled by the new writer, and a subsequent forward upgrade recovers raw rows written during rollback. Aliases come from the same accepted declaration key and are deleted together when the DID is forgotten. No public field or first-seen contract changes. This compatibility does not repair the prior implementation's original legacy-settle bug while that older code is running, nor can a digest-only historical key's raw alias be recovered before its key bytes are encountered again. Avoid rolling back to the faulty revision for histories that have not yet been observed/migrated by the new writer.
