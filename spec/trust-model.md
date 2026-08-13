# Atproto PMR — trust model

_What a relay is trusted with, what it necessarily learns, and what a
malicious one can do — stated as requirements an implementation must
preserve. Requirements language is defined in
[`README.md`](README.md#requirements-language)._

## The position

**A relay is trusted for the availability and ordering of opaque bytes, and
for nothing that determines a key.**

The governing rule, from which most of what follows is derived:

> **Anything a relay asserts that could determine a key, an address, or an
> identity MUST be independently checkable by the device, and MUST be
> checked.** The server proposes; the client verifies.

## Properties an implementation MUST preserve

Stated here as properties; specified in mechanism in
[`wire-api.md`](wire-api.md) and
[`storage-consistency.md`](storage-consistency.md).

### P1 — Key-blindness

A relay MUST NOT be in a position to determine a key. Message and
attachment content is end-to-end encrypted and opaque to the relay, which
moves bytes it cannot read. An implementation MUST NOT introduce a path
where a relay's assertion selects, supplies, or vouches for a key used by a
client.

### P2 — Relayed repo records are CAR

**Relayed atproto repo records MUST be exchanged as
[CAR](https://atproto.com/specs/repository) — the signed commit plus the
inclusion proof — and MUST NOT be exchanged as JSON.** The device verifies
the commit signature against the DID document's signing key and walks the
proof to the record, so a relayed record is authenticated by *provenance*
rather than by trusting its carrier.

A JSON path is not equivalent, and the reason is worth stating because it
looks cheaper. A declaration record can be checked for internal
consistency — that its key package parses and verifies under the
declaration's own current key, bound to a DID string. That check is
necessary and not sufficient once a relay delivers the record: an attacker
can mint a well-formed declaration with their own anchor key, signing
their own key package, bound to a *victim's* DID string, and it passes the
internal-consistency check. What it cannot do is *be in the victim's
repo* — and provenance is exactly what relay delivery discards.

| without CAR | with CAR |
|---|---|
| insert arbitrary forged state | impossible without the repo signing key |
| serve stale-but-genuine state | still possible (replay) |
| withhold an update | still possible (censorship) |

Trust reduces from "the relay can say anything" to "the relay can choose
what to pass on". Forging a record requires the repo signing key, which a
relay does not have. Freshness, not authenticity, is what remains at risk,
and three defenses carry that residual: monotonic `rev` tracking, sampled
spot checks, and multiple independent observers.

### P3 — Closure

**No put's response may reveal which state a destination was in, with one
narrow exception.** A put to a grant mailbox MUST answer `202` for an
unknown address, a closed address, a live address, and a bad tag,
identically in content and in time, with every address-dependent step
running after the response. Address resolution MUST cost the same in all
three cases.

The exception: an **authenticated** pair-mailbox put MAY disclose to its
own sender that their reservation is full (`429` + `Retry-After`).
Per-sender reservation makes this self-referential — it reveals nothing
about the recipient or about any other sender, only a fact about the
sender's own history of sends. It does not extend to a blocked sender, who
MUST see the same shape a live sender would regardless (P4).

Full statement in
[`wire-api.md` §The closure exception](wire-api.md#the-closure-exception)
and [§Blocked senders](wire-api.md#blocked-senders); the storage half is
[consistency item 5](storage-consistency.md#5-uniform-cost-for-address-resolution).

### P4 — Blocking indistinguishability

**A blocked sender MUST NOT be able to distinguish being blocked from being
unanswered.** The behavior presented to them MUST be **synthetic** —
generated independently of the recipient's actual activity — MUST store no
bytes, MUST cause no delivery and no push, and MUST match the real path's
response timing and shape: same verification work, same code path, storage
effects after the response. A cheaper path is itself an oracle.

The concrete synthetic behavior is implementation-defined and SHOULD NOT be
published, because a published simulation is a fingerprint an attacker can
test a relay against. Two conforming relays are not expected to behave
alike.

The tradeoff is recorded in [Non-goals](#non-goals): the simulation
prioritizes not leaking the recipient's real activity over perfectly
concealing the block. Full statement in
[`wire-api.md` §Blocked senders](wire-api.md#blocked-senders).

### P5 — Sender verification

**The pair-put verification algorithm MUST run in full: sender DID from the
signed headers, declaration resolved and CAR-verified, signature checked
against the declaration's key, signed recipient DID and nonce confirmed.**
No step is optional, and `kid` is diagnostic only.

A verifier that checks a signature against a key taken from the message
reproduces the gap the algorithm closes. Self-authentication establishes
*"signed by whoever holds key A"*; it does not bind A to DID X. The chain
is payload → anchor key → declaration → DID, and no link is optional. See
[`wire-api.md` §The verification algorithm](wire-api.md#the-verification-algorithm).

This verification serves the relay's abuse control and policy tiers, not
the recipient's end-to-end security — the device authenticates
independently (see [P8](#p8--the-relays-verdict-is-a-hint)). Keeping that
distinction is what stops the relay's abuse-control role from becoming a
security role.

### P6 — Anti-replay on pre-session puts

**A pair put MUST carry an anti-replay nonce, and a recipient MUST record
the nonces it has seen per sender until a session with that sender
supersedes the handshake.** Content-addressed dedup MUST NOT be treated as
a substitute: dedup records expire, and once a message drains, is acked, or
reaches retention expiry, the same signed bytes replay as a fresh
handshake.

Two supporting requirements travel with it, and either alone is
insufficient: content-address over the **stable message identity**, never
the signature bytes; and reject non-canonical Ed25519 signatures
(RFC 8032 §5.1.7). Signature malleability would otherwise let a malleated
copy slip past dedup.

### P7 — No push custody where a relay delegates

**Where a relay uses push delegation, it MUST NOT be given a platform push
token — it holds a capability instead.** Delegation itself is optional (see
[wire-api.md §Push delegation](wire-api.md#push-delegation-optional)): a
self-hoster who delivers push directly, on a platform where they hold
their own credentials, uses none of this machinery and is not bound by it.
This is a goal the delegation path is built to achieve, not a blanket rule
on every deployment.

For a relay that does delegate: it holds a capability — an identifier and
a symmetric key scoped to a registration — and the push payload MUST be
sealed under a content key shared between the device and this relay, so
the delegated push service relays ciphertext it cannot read. The
capability authorizes *delivery*; the content key protects *content*;
neither substitutes for the other.

A leaked capability is a bounded push-spam surface, revocable and
rate-limited. It never yields readable content.

### P8 — The relay's verdict is a hint

A relay that verified a pair put passes its verdict to the device as a
hint — "I validated this as DID X under anchor A". **A device MUST
re-verify the payload before acting on it**, and MUST NOT treat the hint
as authority. The hint may be used to index and route cheaply; it is an
index, not evidence.

Storage-side, the hint is stored *alongside* the body and never inside it.
An implementation that loses hints degrades performance; one that lets a
hint substitute for verification degrades security.

The same posture applies to every routing-shaped assertion a relay makes:
act on it, verify by outcome, never treat it as authoritative. A relay
could already withhold mail, so routing advice adds no new power — but it
must never steer a *key*.

### P9 — User-controlled discovery

A relay is reached through DID → DID document → PDS, so **switching relays
is a change the user makes through their own PDS, not a permission their
current relay grants.** An implementation MUST NOT make itself a
prerequisite for that change — no relay-held state may be required to
move. This is the only structural answer to a relay that misbehaves.

## What a relay necessarily learns

| data | exposed? | notes |
|---|---|---|
| message content, attachment content | **No** | end-to-end encrypted; the relay moves opaque bytes and is key-blind by construction |
| the served DID (whose relay it is) | Yes | definitional |
| sender DID on a pair-mailbox put | **Yes** | the direct cost of requiring authenticated puts: a signed put names the sender |
| counterpart identity on a grant-addressed put | No | grant addresses are derived and opaque, and name nobody. This is why steady-state traffic offloads to them |
| timing, sizes, message and attachment counts | Yes | unavoidable for a store-and-forward mailbox |
| the user's social graph and interest set | Only if non-public data is an input | |
| platform push token | Only if it does not delegate | a delegating relay holds a capability instead ([P7](#p7--no-push-custody-where-a-relay-delegates)) |
| push payload content | No | sealed under a device ↔ relay key before any delegated push service sees it |

A relay learns **who talks to whom, when, and how much** for first contact
and pair-mailbox traffic, and much less once a conversation moves to grant
addresses. That progression is the **offload policy**: DID-addressed pair
mailboxes for reachability and first contact; steady-state traffic on
opaque grant addresses.

**Pair-mailbox exposure is structural, and no addressing scheme can undo
it.** The recipient DID is inherently in routing — a sender cannot reach
the right relay without it — and the sender DID is inherently in
authentication, since the put is signed and the signature is checked
against the sender's declaration. A pair mailbox has no global address at
all: routing resolves the recipient DID to their relay, and the mailbox is
a local index inside that relay's store, so there is nothing on the wire
for a derivation to obscure.

## The client's fetch posture

**The relay is the primary fetch path for atproto authenticated data;
direct fetch is a targeted request tool, not an enumeration tool.**
Enumeration — refreshing contacts' declarations and profiles, walking the
social graph — runs on the relay, which streams verified results in batch.
Direct fetch is reserved for spot checks in critical flows.

"Authenticated data" means **repo records**, which carry a signed commit
and an inclusion proof. Other categories travel the same channel on
different terms, and a client MUST keep them apart:

| category | examples | authenticated how |
|---|---|---|
| **repo records** | declarations, profiles, follows | **CAR — signed commit + proof.** The relay cannot forge these |
| aggregations | follow counts, feeds, a derived mutuals verdict | not repo-authenticated; computed by an appview, consumed on trust |
| DID documents | the anchor key's root of authority | separate path (PLC log / `did:web`), not CAR |
| blobs | avatars, images | content-addressed; verified by hashing against the CID named in an already-verified record |

Non-key-bearing data — profile text, display names, follow counts — MAY be
consumed on trust; the worst case is cosmetic. The rule is about what
determines a key.

Two consequences cut in opposite directions. **Third-party metadata
exposure falls**: enumeration by direct fetch announces your interest set
to every PDS and appview you touch, while routing through your relay means
counterpart hosts see the relay rather than your device. Against a
self-hosted relay that is a strict improvement; against a hosted one it
concentrates in one known party what was previously scattered. And **spot
checks cost something**: a direct fetch tells the counterpart's PDS that
you are checking, so verification traffic is itself a signal — hence
sampled and rare, and hence multi-observer cross-checking, which costs
nothing at the counterpart's host, as the better default.

**Policy note.** A mailbox policy resting on an aggregation (for example
"mutuals may send attachments") means a relay is trusting an appview for
an authorization decision. That is tolerable because it is not
key-bearing — the worst case is a sender wrongly granted or denied
attachment privileges — but it should be deliberate. A relay that wants to
harden it derives the relation from follow records, which are
repo-authenticated.

## Residual risk and mitigations

| attack | mitigated by | residual |
|---|---|---|
| read content | end-to-end encryption, key-blind relay | none |
| forge a message into an established session | session-layer authentication and sequencing | none |
| replay a session message | session sequencing; content-addressed ack dedup | none |
| replay a pre-session pair put (first contact, recovery) | recipient-tracked per-sender nonce until a session supersedes it ([P6](#p6--anti-replay-on-pre-session-puts)) | a replay in the window before the seen-set exists, e.g. a device restoring from backup |
| insert forged atproto state | CAR exchange + signature verification ([P2](#p2--relayed-repo-records-are-car)) | none |
| **replay stale atproto state** | monotonic `rev` tracking; spot checks; multiple observers | a withheld update is indistinguishable from no update |
| drop or selectively censor | nothing structural | availability loss; recourse is to move ([P9](#p9--user-controlled-discovery)) |
| reveal that a recipient blocked a sender | synthetic behavior, no bytes, no push, decoupled from real activity, answering on the real path's timing profile ([P4](#p4--blocking-indistinguishability)) | the real→synthetic transition may be noticeable to a sender who was measuring; accepted |
| impersonate a sender on a pair put | the four-step verification algorithm ([P5](#p5--sender-verification)); the device re-verifies | none, provided both halves run |
| ring a stranger's phone by minting DIDs | the pool is adjudicated in batch and never pushed per arrival | one wake per adjudication round for an absent device |
| delay or reorder | the session layer tolerates reordering | timing manipulation |
| correlate senders to recipients | grant offload limits the window | the pair-mailbox contact graph is visible |
| exhaust the user's quota | caps and budgets | denial of service against the owner |

Three defenses carry the freshness residual, and all three are
client-side:

- **Monotonic revision tracking.** A device remembers the highest repo
  `rev` it has seen for a DID and rejects anything older, reducing replay
  to withholding.
- **Spot checks.** Key-bearing moments — first contact, an observed
  anchor-key change — may trigger an independent fetch. Sampled and rare,
  because a direct fetch is itself a signal to the counterpart's host.
- **Multiple independent observers.** A device MAY register observation
  with more than one relay and cross-check them; a split view is evidence
  of misbehavior no single relay can suppress.

That last one holds for **any** DID under watch, including the device's
own: reading a declaration requires no authority over anyone, so a second,
non-delegate relay can watch the same own-DID declaration and report back,
catching a delegate that misrepresents what it sees. What does require the
canonical-delegate relationship is unrelated to reading: it is being the
relay a peer's mailbox put resolves to. Cross-checking observation and
holding mailbox authority are independent, and only the second is
restricted to one relay.

**Observation-only relays** follow directly: a deployment MAY serve
observation alone, with no mailboxes and no delegation. An operator
running one gives self-hosting users an independent verifier without
becoming their mail host.

## Trust asymmetries

- **Your relay versus your counterpart's.** Choosing a relay you trust
  does not protect what a counterpart's relay learns when you put to it.
  Self-hosting reduces exposure of your inbox, not of your outbound
  contact metadata.
- **Hosted and self-hosted are the same protocol, a different operator.**
  Self-hosting moves metadata to a host the user controls and changes
  nothing about the protocol's guarantees. An implementation MUST NOT give
  a hosted deployment a privileged path a self-hosted one cannot take.
- **A delegated push service** learns that a notification is due for a
  given capability, plus its size and timing — not its content, and not
  the sender.

## Recourse

**There is no cryptographic defense against a relay that drops messages.**
The structural answer is that a user can leave: because a relay is reached
through DID → DID document → PDS, switching is a change the user makes
through their own PDS rather than a permission their current relay grants.
That is [P9](#p9--user-controlled-discovery), and it is why the discovery
hop being user-controlled matters more than where it is eventually
specified.

## Non-goals

Stated so that a bounded property is not read as a broken one:

- **Hiding the fact of communication from your own relay.** A mailbox host
  knows it is holding mail.
- **Metadata privacy against a global passive adversary.**
- **Anonymity for pair-mailbox senders.** Traded deliberately for
  authenticity and abuse control: a pair mailbox is indexed by sender DID,
  so a put is already a claim of identity.
- **Hiding a sender's *own* quota state from them.** Fullness is disclosed
  deliberately, because per-sender reservation makes it self-referential.
  What stays hidden is whether the recipient blocked them.
- **Concealing a block from a sender who was measuring the recipient's
  real cadence before it.** What a blocked sender sees is deliberately
  synthetic rather than a mirror of real activity: a real mailbox's
  cadence *is* the recipient's actual behavior, and a blocked sender is
  exactly who must stop seeing it. Blocking guarantees the stronger
  property — that a blocked sender's view stops carrying any information
  about the recipient's actual activity — at the accepted cost that the
  transition itself may be noticeable.
- **Availability guarantees against a hostile relay.** See
  [Recourse](#recourse).

## What a client must build

Several properties above are client-side and do not arrive with a relay
implementation. A client that skips them removes the guarantee, and the
relay cannot tell.

- **CAR verification.** Fetching a declaration as JSON and trusting the
  transport is not equivalent, for the reason in
  [P2](#p2--relayed-repo-records-are-car). A verifier needs CAR framing,
  the DAG-CBOR profile, CID computation, MST proof walking, and
  commit-signature verification. This is a prerequisite for consuming
  relayed observation, and it is worth building against the **direct**
  fetch path first: same code, and it closes a live gap before anything
  depends on the relay path.
- **Both blessed curves.** atproto commit signatures use k256 and p256,
  and k256 is the common case, so a p256-only verifier is a staging step
  rather than a destination. Two details a verifier MUST get right:
  atproto requires **low-S normalized** signatures, and omitting the
  `s ≤ n/2` check silently reintroduces signature malleability; and `r`
  and `s` MUST be range-checked against the group order before any point
  arithmetic. Gate the implementation on an adversarial vector corpus —
  [Project Wycheproof](https://github.com/C2SP/wycheproof)'s secp256k1
  ECDSA vectors are built for these mistakes — rather than on
  hand-written tests, since a verifier that wrongly *accepts* is a
  security hole and modular-arithmetic bugs are subtle.
- **Grant address re-derivation.** A client re-derives each issued grant
  address from its own key material and rejects a relay that claims
  otherwise.
- **Payload re-verification.** The full four-step algorithm, on the
  device, independent of the relay's hint.
- **The per-sender nonce seen-set**, retained until a session supersedes
  the handshake.
- **The composite block.** Blocking a person means blocking the DID at the
  relay *and* closing the grant addresses vended to that peer. Only the
  device holds that mapping.

## Not yet specified

- **Which flows get spot checks**, and how far behind a `rev` may be
  before a device refuses relayed state.
- **Multi-observer mechanics** — how a device registers observation-only
  relays, and what it does on a split view (warn, refuse, or prefer the
  higher `rev`).
- **Quota and abuse limits as a denial-of-service surface against the
  owner.** The caps that bound an attacker also bound the owner.
- **Nonce width and seen-set retention**, including what a device
  restoring from backup does about a seen-set it no longer holds. See
  [`wire-api.md`](wire-api.md#not-yet-specified).
