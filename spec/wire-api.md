# Atproto PMR — wire API

_The normative HTTP and socket surface an Atproto PMR exposes: what clients
program against and what an implementer implements. Its persistence
counterpart is [`storage-consistency.md`](storage-consistency.md); the
properties it exists to protect are in [`trust-model.md`](trust-model.md).
Requirements language is defined in [`README.md`](README.md#requirements-language)._

The surface is REST. Every endpoint here is new; none is shaped by an
existing client's envelope.

## Conventions

### Versioned base path

All endpoints live under `/pmr/v1/…`, plus the unversioned
`/.well-known/pmr-config.json`, which advertises supported versions.

### Request authentication

**Requests are authenticated with
[RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
carrying a server-issued challenge in the signature's `nonce` parameter.**
Freshness is server-controlled, not client-asserted:

```
POST /pmr/v1/grants
Content-Digest: sha-256=:<base64>:
Signature-Input: pmr=("@method" "@authority" "@path" "content-digest");
                 nonce="<server challenge>"; created=1754960000;
                 keyid="<thumbprint>"; alg="ed25519"
Signature: pmr=:<base64>:
```

Ed25519 is a registered algorithm (§3.3.6), so existing key material works
unchanged. The signature base canonicalization is specified with test
vectors, so it is not this document's job to define what "exactly what is
signed" means. Body integrity rides `Content-Digest`
([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html)) as a signed field
rather than a hand-built preimage. `nonce` is a defined parameter, so
carrying a server challenge is conformant use.

**The profile.** A conforming request:

- MUST cover the components `@method`, `@authority`, `@path`, and — on any
  request with a body — `content-digest`.
- MUST carry a `nonce` parameter holding a challenge the server issued, and
  the server MUST reject a signature whose challenge is unknown, expired,
  or bound to a different realm or destination.
- MUST use `alg="ed25519"`. A verifier MUST pin the algorithm to what the
  signer's *known* key type implies and MUST NOT trust the `alg` carried in
  the message.
- MUST set `keyid` to the
  [RFC 9679](https://www.rfc-editor.org/rfc/rfc9679.html) COSE Key
  Thumbprint of the key that signs — the registration key or the declared
  anchor key, according to realm.
- SHOULD include `created`, per the RFC's recommendation. Freshness rests
  on the challenge, not on the client's clock.

**`content-digest` is REQUIRED, not RECOMMENDED, on bodied requests.** RFC
9421's signature base covers no body bytes at all: without
`content-digest` among the covered components, a signature authenticates
*which* request was made but not *what it carried*, and an attacker could
swap the body without invalidating the signature.

**`Content-Digest` is scoped to requests, inside the signature, and nowhere
else.** It MUST NOT be sent on responses and MUST NOT appear inside a
protocol payload. Its value depends on being signed: a signed digest binds
the party being authenticated, while a bare digest header is only an
assertion by whoever sent it — and on a response that party is the relay,
which the trust model does not trust for content. Content integrity is the
sealed envelope's job; those digests are minted by the sender and carried
end-to-end encrypted.

**The challenge is server-issued, not a client timestamp.** With
client-asserted `created`/`expires` and a server skew window, the client
decides when a request is fresh, a key holder can pre-sign requests for
future windows, and every claim in the request originates client-side. A
server-issued challenge means a signature cannot exist before the server
chose to issue one; the mint is a gate where policy and rate limits apply
before any body is parsed; and the challenge is bound at mint to a realm
and a destination the client cannot restate.

**`keyid` is a thumbprint, not a key.** The server already holds the key in
both realms — the registration record stores it, and an anchor-realm
challenge was minted bound to it — so shipping key bytes in every request
header is unnecessary.

**The round trip is amortized.** Every authenticated response carries a
next-challenge header, so a client holds a fresh challenge at all times and
pays the mint round trip only on its first request:

```
Germ-Next-Challenge: :<base64>:; expires=@1754960600
```

A challenge MAY be a server-MAC'd token carrying its own issue time and
binding, verified on redemption without a lookup, the way QUIC retry
tokens work — this removes the unbounded per-mint write surface a naive
implementation would have. Implementations SHOULD prefer it.

### Realms

Three authorization realms exist, distinguished by **the key that signs**,
not by separate endpoint families:

- the **anchor realm** — the declared anchor key, for DID-scoped
  operations.
- the **grantPut realm** — a grant's own `authKey`, scoping a
  put-challenge to the single address that grant derives. Unlike the other
  two realms it authenticates no identity at all, only possession of that
  one capability — see
  [Grant address and put-tag derivation](#grant-address-and-put-tag-derivation).
- the **registration realm** — a registration key, used by the push
  service in the optional [push delegation](#push-delegation-optional)
  path.

A challenge is minted bound to a realm and MUST NOT verify against
another. An Atproto PMR implements the anchor and grantPut realms; it does
not implement the registration realm, because push reaches its users by
delegation rather than by holding a push token.

### Content types

| type | used for |
|---|---|
| `application/cbor` | the default for request and response bodies |
| `application/vnd.ipld.car` | relayed atproto repo records |
| `application/json` | the capability document only |

`Accept` selects where a resource has more than one representation.

### Deterministic CBOR

**Deterministic CBOR means
[RFC 8949 §4.2.1](https://www.rfc-editor.org/rfc/rfc8949.html#name-deterministically-encoded-c),
and decoders MUST reject input that does not conform.** Naming the section
matters: "deterministic CBOR" unqualified is ambiguous between §4.2.1 and
the stricter
[dCBOR](https://www.ietf.org/archive/id/draft-mcnally-deterministic-cbor-08.html)
profile, and RFC 9679 thumbprints — the key identity used throughout this
specification — are defined against 8949.

Rejection, not lenient decoding, is what matters for security: a peer that
sends an alternate encoding of the same value changes the bytes anywhere
they are compared or hashed.

An implementation MAY emit the stricter dCBOR profile, which is a strict
subset and therefore always satisfies §4.2.1. An implementation that emits
plain §4.2.1 is fully conformant and MUST NEVER be rejected for emitting
it. Requiring dCBOR of a peer would reject conforming implementations.

### Header syntax

Custom headers are
[Structured Fields](https://www.rfc-editor.org/rfc/rfc9651.html) (RFC 9651,
which obsoletes 8941) — RFC 9421 and RFC 9530 are themselves defined in
Structured Fields, so every implementation already has the parser. The
next-challenge header shown above is a Byte Sequence item with an expiry
parameter, using the Structured Fields **Date** type rather than a bare
integer.

### Timestamps

Timestamps are CBOR tag 1 (epoch) with integer seconds in bodies, and
Structured Fields Date in headers. Integer, never float. Second granularity
is sufficient for every deadline in this specification: grant expiry,
retention, challenge TTL, and the synthetic timing a blocked sender
observes.

### Content addressing and idempotency

A message's identifier is derived from its destination and its bytes, so a
retried put is naturally deduplicated rather than needing an idempotency
key. Two constraints on what that derivation covers are stated under
[Malleability](#malleability) and are security requirements.

Content addresses are algorithm-prefixed and self-describing: an algorithm
identifier followed by the digest bytes. They are not multihash and not
CIDs. CIDs are consumed where atproto owns the bytes — CAR blocks and blob
references inside repo records — and emitted nowhere.

### Key material

**Key material on the wire is `COSE_Key`**
([RFC 9052](https://www.rfc-editor.org/rfc/rfc9052.html)), encoded per RFC
8949 §4.2.1, with RFC 9679 thumbprints as key identity. Identity is
standardized: a thumbprint hashes a canonical subset of the required
parameters under deterministic CBOR, so the same key always yields the
same identifier regardless of encoding.

`did:key` does not fit: atproto's blessed key types are k256 and p256
only, so Ed25519 anchor keys are not expressible in the atproto profile.

**The one exception is the declaration's frozen key fields.** The relay
resolves a sender DID to the germ declaration record in that DID's atproto
repository and reads the anchor key from it. That record predates this
specification, is already parsed by shipped clients, and its key fields
are not COSE. The field an implementer must read has this shape:

> a single algorithm identifier byte, followed immediately by the raw
> public key bytes for that algorithm — no length prefix, no enclosing map
> or array, no framing. The byte identifies the algorithm and therefore
> the expected key length; for an Ed25519 anchor key the remainder is the
> 32-byte public key.

An implementation MUST convert that field to a `COSE_Key` at ingest, once,
and MUST NOT propagate the foreign encoding any further. That field is the
whole of an implementer's exposure to the foreign format: the relay never
parses the declaration's key package, never writes a declaration, and
every other key on every other surface here is COSE. The record's full
field inventory belongs to the declaration's own format and is out of
scope for this document.

Keys persist self-describing, never as fixed-width columns, so a new
algorithm arrives as a new identifier rather than a schema migration. On
COSE surfaces that identifier comes from the COSE registry.

## The closure exception

Three related words collide, so they are fixed once here. **Closure** is
the security property: no put's response reveals which state a destination
was in. **Close/reopen** and **block/unblock** are both the *action* that
puts a mailbox into one of those states, and both are reversible.

The two verbs differ in **what they name**, not in what an owner may do:
close/reopen names a grant address
([Grants](#grants--the-core-capability)); block/unblock names a sender DID
on a pair mailbox ([Blocked senders](#blocked-senders)). Reversible
suppression is available for **both** kinds of mailbox. The asymmetry lies
elsewhere — in who can map a *person* to the thing being named — and is
spelled out under Blocked senders.

REST convention pushes toward informative status codes. For puts to grant
mailboxes, that convention conflicts with the security requirement: a
`404` for an unknown address, a `410` for a closed one, or a faster answer
for either, is an oracle, since closure exists so a blocked sender cannot
discover they were blocked, and grant puts carry no authenticated identity
to reserve a quota against. Therefore:

- A put to a grant mailbox **MUST answer `202 Accepted`**. An unknown
  address, a closed address, a live address, and a bad authorization tag
  MUST be **identical in content and identical in time**.
- Every address-dependent step — resolution, tag verification, capacity
  checks, storage, delivery, push — MUST run **after** the response has
  been produced.
- Address resolution MUST cost the same for a live address, a closed one,
  and one that never existed
  ([storage](storage-consistency.md#5-uniform-cost-for-address-resolution)).

An implementation that returns `404` or `410` instead has broken this
property.

Pair mailboxes differ, because authentication plus per-sender reservation
makes fullness self-referential — see below.

## Resources

`{did}` is a URL-encoded DID. The authenticated identity determines *whose*
registration is addressed, so an owner's own resources are singular and
need no identifier in the path.

### Registration

| method | path | notes |
|---|---|---|
| `POST` | `/pmr/v1/registrations` | create: DID + declared anchor key (`COSE_Key`) + optionally a push grant. **Never a push token** |
| `GET` | `/pmr/v1/registration` | read own |
| `PATCH` | `/pmr/v1/registration` | mutable registration fields |
| `DELETE` | `/pmr/v1/registration` | deregister |

An Atproto PMR **MUST NOT** accept or store a platform push token. Push, if
the deployment needs delegation at all, is authorized by a capability — see
[Push delegation](#push-delegation-optional).

A registration lives while the anchor key stays in the DID's declaration.
An implementation SHOULD watch that declaration, and when the declared key
disappears it SHOULD **pause** rather than tear down: stop accepting
incoming DID-addressed mail and stop acting on behalf of the DID, continue
accepting grant-addressed mail, and continue watching that one DID's
declaration to see whether the key returns.

Per-DID state MUST be keyed by **DID**, never by anchor key, so that key
replacement does not foreclose either possible future semantics (rebind
under a fresh challenge, or a fresh registration).

### Grants — the core capability

| method | path | notes |
|---|---|---|
| `POST` | `/pmr/v1/grants` | request N; returns `{key, address, expiry}` triples |
| `GET` | `/pmr/v1/grants` | list live grants |
| `PATCH` | `/pmr/v1/grants/{address}` | `{closed: true\|false}` — reversible |
| `DELETE` | `/pmr/v1/grants/{address}` | invalidate permanently |

State transitions are a `PATCH` on the resource rather than `…/close` and
`…/reopen` action endpoints.

A grant address is derived from key material the client also holds. **A
client MUST re-derive and verify each issued address rather than accepting
the server's word for it**, and MUST reject a grant whose address it
cannot reproduce. The server proposes; the client verifies.

### Grant address and put-tag derivation

**Normative.** `key` — the 32-byte symmetric secret a grant issues — is
the input to two domain-separated HMAC-SHA256 derivations, both run
locally by whichever side needs them and never transmitted:

```
address = HMAC-SHA256(authKey, "germ-pmr:grant-addr:v1" || host)
tag     = HMAC-SHA256(authKey, "germ-pmr:grant-put:v1" || addressString
                                || nonce || bodyDigest)
```

`address` is what [Grants](#grants--the-core-capability) requires the
client to re-derive and what routes a put globally, before any relay is
known. `tag` is what a [grant put](#the-grant-put-payload) carries to
prove possession of `authKey` without transmitting it on every request —
the relay verifies by recomputing, never by comparing bearer secrets.

The two labels are domain-separated from each other, from
[the pair-put type marker](#the-pair-put-payload), and from
[push delegation's HMAC](#push-delegation-optional): a value computed for
one purpose MUST NOT be reinterpretable as valid for another, even under a
key that happens to be reused across them. They are also deliberately
**not** germ-service's legacy v2 address scheme (`germ-addr:v1` /
`germ-put:v1`) — that scheme belongs to the anchor-key-indexed inbox this
specification retires, and giving the new one its own labels means an
`authKey` never accidentally validates against both.

Byte representations are fixed so an independent implementation
reproduces these exactly:

| field | representation |
|---|---|
| `host` | UTF-8 bytes of the relay's own hostname, unencoded |
| `addressString` | UTF-8 bytes of `address`'s **base64url string form**, unpadded (43 bytes for a 32-byte HMAC output) — not the raw bytes, and not the URL-percent-encoded path segment |
| `nonce` | UTF-8 bytes of the redeemed put-challenge's **string form** — the same value the challenge store keys on ([Freshness and replay](#freshness-and-replay)), not a byte-decoding of it |
| `bodyDigest` | the raw 32-byte SHA-256 digest of the exact message bytes carried in the put |

`addressString` and `bodyDigest` are fixed-length; `nonce`'s length
follows the deployment's own challenge byte length once base64url-encoded
— constant within a deployment, not mandated across them. That is not a
concatenation hazard: both sides always know each field's length
independently rather than recovering it by splitting the HMAC input back
apart, so a variable length here has nothing to make ambiguous.

**Known-answer test vectors** for both derivations, computed
independently of the reference implementation, are published alongside it
at `packages/core/test/grant.spec.ts` in this repository.

**Wire encoding of `address` itself**: the base64url string form,
unpadded — the same string used to build `addressString` above. Base64url
uses no characters requiring percent-encoding, so it is carried in the
`{address}` path segment (`POST /pmr/v1/mailboxes/{address}/messages`)
unmodified, and in `PATCH`/`DELETE /pmr/v1/grants/{address}` the same way.

### Delivery — peer-facing

| method | path | responses |
|---|---|---|
| `POST` | `/pmr/v1/mailboxes/{address}/messages` | **`202` always** — see [the closure exception](#the-closure-exception) |
| `POST` | `/pmr/v1/inboxes/{did}/messages` | pair mailbox; sender identified by the payload signature |

For a pair put, the permitted responses are exhaustive:

- **`202 Accepted`** — for a provisioned sender with room, for an
  unprovisioned sender (accepted into the [recovery pool](#the-recovery-pool)),
  for a sender inside a discard window, and for a
  [blocked sender](#blocked-senders) whose synthetic state has room.
- **`429 Too Many Requests` with `Retry-After`** — when *the sender's own*
  reservation is full.

Nothing else that depends on the recipient. A pair put MUST NOT disclose
whether the recipient is active, whether the sender was blocked, whether
the sender is provisioned, or whether the recipient exists in any state
other than one that would produce these two answers.

One narrow exception, and the condition on it is what keeps it safe: a
**structurally malformed** request — an undecodable envelope, a
non-canonical signature, a payload over the published maximum — MAY be
refused with `400`. Every such check MUST be evaluated **before any
recipient- or sender-dependent lookup**, so its outcome is a function of
the request bytes alone. A sender already knows whether their own request
is well-formed and how large their own payload is, so this tells them
nothing they did not supply. An implementation that cannot decide a `400`
without consulting recipient state MUST answer `202` instead.

**Fullness is disclosable because senders are authenticated and each
sender's mailbox is reserved to them**: a full mailbox is a fact about the
sender's own reservation, revealing nothing about other senders and
nothing the sender could not already infer from silence. `429` +
`Retry-After` is that self-referential disclosure. Grant puts keep the
uniform-`202` contract because they have no authenticated identity to
reserve against.

**The real path refuses when full; it MUST NOT accept and evict.** A pair
mailbox at capacity rejects the put and tells the sender: this does not
silently destroy mail the sender was told had been accepted, a refusal is
actionable where a silent eviction is not, and it makes the per-sender
quota self-limiting, since a sender who floods locks out only themselves.
The recipient keeps the *oldest* N messages from a flooding sender rather
than the newest, since first contact is what these mailboxes are for.

**Sender authentication is REQUIRED for pair puts.** A pair mailbox is
indexed by sender DID, so a put is already a claim of identity, and
accepting that claim unauthenticated is an impersonation and
denial-of-service surface on the (sender, recipient) relationship. Closure
does not depend on anonymous puts — it is preserved by uniform acceptance.

**No open DMs.** A *provisioned* pair mailbox MUST come into being only
from something the recipient controls — their follow graph, or their
device's own contact provisioning. An implementation MUST NOT provision a
pair mailbox on a sender's request. Which recipient-side sources a
deployment honors is implementation-defined; that provisioning is
recipient-side is not. A sender with no provisioned mailbox is not
refused: see [the recovery pool](#the-recovery-pool).

A deployment MAY apply policy tiers to pair mailboxes — for example
permitting attachments or larger limits from mutuals. Tiers being
observable to the sender is acceptable: mutual status is public atproto
state, so the tier reveals nothing a sender could not compute. A tier
resting on an aggregation means trusting an appview for an authorization
decision; see
[`trust-model.md`](trust-model.md#the-clients-fetch-posture).

### The grant-put payload

**PROVISIONAL BODY SHAPE**, as with the challenge mint: concrete CBOR
schemas are tracked separately. The shape below is the minimum that
expresses the three fields a grant put needs, chosen so that settling the
schema later is a decode change rather than a redesign:

```
{ "n": nonce, "t": tag, "m": message }
```

`nonce` is a challenge redeemed from the **grantPut realm**
([Realms](#realms)), bound to this address (`s` = `address` at mint time
— `POST /pmr/v1/challenges` with `{"r": "grantPut", "s": address}`), the
same mechanism as any other realm. `tag` and `message`'s digest are
computed as in
[Grant address and put-tag derivation](#grant-address-and-put-tag-derivation).

**Why no per-sender anti-replay nonce, unlike a pair put.** Grant
addresses carry steady-state traffic on an already-established session
([`trust-model.md`](trust-model.md#p6--anti-replay-on-pre-session-puts)),
and forging or replaying a message into an established session is a
session-layer property, not a relay one — the residual there is already
"none." The put-challenge's job is narrower: proving freshness and
possession of `authKey`, not sequencing application content. What a relay
still owes against replay is what [Freshness and replay](#freshness-and-replay)
already states for every challenge-reachable operation — **puts are
content-addressed and deduplicated** — which is sufficient here because
`message` is content-addressed exactly as a pair put's payload is.

**The response contract is stricter than a pair put's, not just
uniform.** A pair put resolves and verifies before answering, and
achieves uniformity by answering `202` on every branch. A grant put has no
self-referential disclosure to permit at all, so it goes further: **no
address-dependent step runs before the response.** The only synchronous,
pre-response work is rejecting a structurally malformed request — an
undecodable body, a payload over the published maximum — decided from the
request bytes alone, exactly as a pair put's `400` is. Address resolution,
challenge redemption, tag verification, storage, and delivery all run
strictly after the `202`.

### The pair-put payload

A **`COSE_Sign1`** ([RFC 9052](https://www.rfc-editor.org/rfc/rfc9052.html))
signed by the sender's declared anchor key, for the same reason RFC 9421
governs requests: the `Sig_structure` canonicalization is specified with
test vectors. It composes with what is already adopted here — `COSE_Key`,
RFC 9679 thumbprints, deterministic CBOR — and EdDSA is a registered COSE
algorithm, so Ed25519 anchor keys work unchanged.

**Protected headers**, all covered by the signature and all readable by the
relay without touching the body:

| header | why it is signed |
|---|---|
| `alg` (EdDSA) | pinned by the verifier to the algorithm the sender's *declared* key type implies, never trusted from the message |
| `kid` — the RFC 9679 thumbprint of the sender's anchor key | diagnostic, not authority (see below); makes a rotation legible rather than an unexplained failure |
| sender DID | the identity claim, and the DID whose declaration verification resolves |
| **recipient DID** | binds the message to its destination |
| type marker **+ format version** | domain separation *and* version separation: an anchor signature over a v1 pair put MUST NOT verify as a registration, a session frame, or a v2 pair put |
| anti-replay nonce | pre-session freshness — see [Anti-replay](#anti-replay) |

**Payload**: the sealed message, opaque at this layer. The relay never
parses it and this format does not constrain it.

#### The verification algorithm

In order, no step optional:

1. Take the **sender DID from the signed headers** — never from the
   relay's routing hint, which the trust model does not trust.
2. Resolve that DID → declaration → anchor key, **CAR-verified**
   ([trust](trust-model.md#p2--relayed-repo-records-are-car)).
3. Verify the `COSE_Sign1` against **that** key — the declaration's, not
   any key or thumbprint carried in the message.
4. Confirm the signed recipient DID is this recipient, and that the nonce
   is unseen.

`kid` participates in **none** of the trust. A verifier that checks the
signature against a key it took from the message reproduces the gap this
algorithm closes: an attacker signs their own payload with their own key
and claims any DID they like. The thumbprint cannot be verified against —
there is nothing there to check a signature with — so it closes that path
and makes rotation diagnosable (a mismatch says "signed under a different
key of theirs"). The guarantee is step 3, not the header.

The same distinction applies to devices, not just relays. Self-
authentication establishes only *"this payload was signed by whoever holds
key A"*; it does not bind A to DID X. That binding comes only from X's
declaration, CAR-verified. The chain is payload → anchor key → declaration
→ DID, and no link is optional.

#### Why the recipient DID must be signed

Without it, a put captured at Alice's relay replays at Carol's and
verifies: valid signature, real sender, nothing saying where it was meant
to go. Routing carries the recipient DID in the path, but the path is not
signed — the RFC 9421 request signature dies at the relay, so the only
durable binding is inside the payload. A verifier MUST reject a payload
whose signed recipient DID is not the recipient it is being delivered to.

#### Anti-replay

**Anti-replay is REQUIRED, not optional.** The pair mailbox exists for
first contact and recovery — states with no session layer yet — so this
signature is the entire replay boundary, with no session sequence number
behind it.

**Content-addressed dedup is not a substitute.** Dedup holds only while
the dedup record lives, so once a message drains, is acked, or reaches its
retention expiry, the identical signed bytes replay as a fresh handshake,
and a captured first-contact put could be re-delivered indefinitely.

The payload therefore carries a nonce, and the recipient records the
nonces it has seen per sender until a session with that sender supersedes
the handshake, at which point the seen-set can be dropped.

An expiry window short enough to bound replay is too short for recovery,
which is legitimately long-delayed (a device offline for an extended
period); one long enough for recovery leaves replay open just as long.
Scoping to the pre-session handshake resolves this. A plain freshness
window MUST NOT be substituted for the nonce.

Nonce width and seen-set retention are [not yet specified](#not-yet-specified).

#### Malleability

Ed25519 signatures are malleable — a non-canonical `S` is different bytes
— so content-addressing the signed envelope would let a malleated copy
slip past dedup. Two requirements, and either alone is insufficient:

- Content-address over the **stable message identity** (the sealed
  payload), never over the signature bytes.
- **Reject non-canonical signatures**
  ([RFC 8032 §5.1.7](https://www.rfc-editor.org/rfc/rfc8032.html#section-5.1.7)).

### Blocked senders

Blocking a sender is reversible — the pair-mailbox counterpart of
close/reopen on a grant address. A blocked sender MUST NOT be able to
distinguish being blocked from being unanswered.

The following are normative:

1. **Synthetic.** The behavior presented to a blocked sender MUST be
   generated **independently of the recipient's actual activity**. It MUST
   NOT mirror, sample, or derive from the recipient's real reads, drains,
   or presence.
2. **No storage.** The relay MUST NOT store the message bytes of a put from
   a blocked sender.
3. **No delivery.** The put MUST NOT produce a queue entry, a socket frame,
   a push, or any other signal to the recipient's devices.
4. **Timing and shape parity.** The response MUST match the real path: the
   same sender verification runs, nothing returns early, the response is
   produced by the same code path, and storage effects sit after the
   response on both paths. A path that skips work answers faster, and the
   speed difference is itself an oracle.
5. **Same response vocabulary.** A blocked sender sees only `202` and
   `429` + `Retry-After`, on the same terms as
   [any pair put](#delivery--peer-facing). Any quota state a deployment
   discloses to real senders MUST also be produced, consistently, for
   blocked ones.

The concrete synthetic behavior is implementation-defined and SHOULD NOT
be published: a published simulation is a fingerprint an attacker can test
a relay against. Implementations are free to change it over time,
including stochastically, and two conforming relays are not expected to
behave alike.

Nothing in the above requires scheduled work. A conforming implementation
can hold the synthetic state as a small per-sender record and evaluate it
at the moment a put arrives.

The tradeoff: the simulation prioritizes not leaking the recipient's real
activity over perfectly concealing the block. A real mailbox's
fill-and-drain reflects the recipient's actual reading — that is inherent
in disclosing fullness at all — and a blocked sender is exactly the party
that feed must be cut off from. Mirroring the recipient's true behavior
would conceal the block while continuing to leak their activity. The
accepted residual is that a sender who was measuring cadence before the
block may notice the transition from real to synthetic.

| method | path | notes |
|---|---|---|
| `GET` | `/pmr/v1/blocks` | list blocked sender DIDs |
| `PUT` | `/pmr/v1/blocks/{did}` | block |
| `DELETE` | `/pmr/v1/blocks/{did}` | unblock; reversible by construction |

A full, user-level block covers both mailbox kinds. This endpoint is the
pair-mailbox half, keyed by sender DID; the grant half is
`PATCH /pmr/v1/grants/{address}` with `{closed: true}`, equally reversible
([Grants](#grants--the-core-capability)).

**A relay can suppress either kind.** What it cannot do is map a grant
address back to a sender, because a grant put names nobody — that is the
whole point of a grant address. So a *person*-level block is a client-side
composite for want of a **mapping**, not for want of a capability: the
device blocks the DID here *and* closes the grant addresses it vended to
that peer, because only the device knows which addresses those are. A
relay implementer should not attempt to synthesize the second half;
inventing it would require exactly the sender-to-address mapping grants
exist to prevent.

Blocks do not need to migrate when a user changes relays. The client holds
the block list durably and publishes it to a new relay as part of bringing
that relay up to speed, and a new relay is not reachable until the client
publishes it. Grants need nothing at all — a relay change leaves the old
addresses behind entirely, so that half of a composite block fails closed.

### The recovery pool

**A sender with no provisioned mailbox MUST NOT be refused.** The
unprovisioned case is typically session recovery, not a stranger knocking:
a DID the client has permitted and knows about but has not told the
server about, because the device was offline when the relationship
formed, or restored from backup, or switched relays, or the relationship
was formed on another device in the set. Refusing would break recovery in
precisely the situation DID addressing exists for.

Puts from unprovisioned senders land in a catch-all pool whose policy is
the inverse of a provisioned mailbox's:

| | provisioned pair mailbox | recovery pool |
|---|---|---|
| depth | per-sender reservation | **shallow** — a recovery attempt, not a thread |
| admission | recipient-provisioned only | **wide** — the server cannot know who is permitted |
| under pressure | **refuses**, keeping oldest — first contact is the point | **newest wins** — the freshest attempt carries current state |

A provisioned mailbox keeps the oldest because first contact is what it is
for; a recovery pool keeps the newest because the freshest attempt carries
current state and stale attempts are worthless.

Anti-abuse is deliberately not in the protocol beyond the requirement that
a sender hold a real DID with a published declaration and produce a valid
signature. Volume is handled operationally — WAF, rate limiting,
reputation — where it adapts without a spec change.

**The pool MUST NOT be pushed per arrival.** Per-arrival push would let
anyone who can mint a DID ring a stranger's phone at will — a harassment
surface arriving by a path blocking does not cover, since these senders
were never provisioned and so were never blockable.

Instead the pool is **adjudicated in batch** by the device:

| method | path | notes |
|---|---|---|
| `GET` | `/pmr/v1/pool` | list the DIDs holding pool entries — **DIDs only, never bodies** |
| `POST` | `/pmr/v1/pool/adjudication` | provision-or-discard per DID; bodies are delivered for the provisioned and dropped for the rest |

The server pooled these senders because it could not evaluate them, so it
offers the device the only judgement that exists — provision these,
discard those — and acts on the answer. "No open DMs" becomes a protocol
step rather than an unstated client-side filter, and the pool becomes
self-clearing, its size governed by the adjudication cycle rather than by
an eviction policy.

**A round is triggered by threshold or by next connect, never by a
schedule.** On connect, the pool notice rides out as the last frame after
the queue drains — real mail first, then what is merely waiting to be
judged, at no extra cost. On threshold, an absent device is woken — the
only case that spends a notification, and it spends one per round, never
one per arrival.

**Wake and fetch, not push-the-list.** The notification MUST carry no
list; the device fetches one. An inline list would be capped by the push
platform's payload ceiling at a size an attacker could reach simply by
minting DIDs, and a fetched list is unbounded. It also leaves the wake
independently rate-limitable.

**Discard is time-bounded** — neither one-shot nor standing. While a
sender's discard window is live, arriving puts from that sender are
dropped without pooling; once it lapses, the sender pools normally again.
One-shot would make adjudication a treadmill (an attacker re-sends
immediately and the same DIDs reappear next round); standing would be a
block in all but name, drawing a permanent consequence from a judgement
made on incomplete information — the pool exists precisely for the case
where the device's own knowledge is behind, mid-restore or mid-resync.

A put from a DID inside its discard window still answers `202`, identical
to being pooled and later discarded, so the sender cannot distinguish
suppression from ordinary pooling.

This is safe to drain because the device verifies senders itself: the
relay cannot evaluate admission for a sender it does not know, but an
attacker flooding the pool cannot impersonate a permitted DID, so the
client's filter rests on cryptography rather than a relay decision that
was never made.

Pool sizing is [implementation-defined](#limits-are-implementation-defined).

### Delivery — owner-facing

| method | path | notes |
|---|---|---|
| `GET` | `/pmr/v1/messages?cursor=` | catch-up after being away |
| `POST` | `/pmr/v1/messages/acks` | batch ack; idempotent, up to the capability document's limit |
| `GET` | `/pmr/v1/events` | `Upgrade: websocket` — delivery, acks, observation updates, and the pool notice as the last frame after the queue drains |

Acks are idempotent: a repeated ack for an already-removed message MUST
succeed rather than error, because the client's ack path retries.

A pair-mailbox delivery carries the relay's **verification hint** — the DID
and anchor key it validated the payload against. The hint is an index and
a convenience, not evidence, and a device MUST re-verify the payload
before acting on it; see
[`trust-model.md`](trust-model.md#p8--the-relays-verdict-is-a-hint).

### Attachments

| method | path | notes |
|---|---|---|
| `POST` | `/pmr/v1/attachments` | upload |
| `GET` | `/pmr/v1/attachments/{digest}` | fetch — **standard `Range` header** for resumable segment reads |
| `GET` | `/pmr/v1/attachments` | list, for post-restore reconciliation |
| `DELETE` | `/pmr/v1/attachments/{digest}` | ack/dispose; idempotent, and identical whether consumed or discarded |

Ranged reads are REQUIRED: a client resuming an interrupted transfer picks
up at a segment boundary.

### Observation

| method | path | notes |
|---|---|---|
| `GET` | `/pmr/v1/observations` | list DIDs under observation |
| `PUT` | `/pmr/v1/observations/{did}` | declare interest |
| `DELETE` | `/pmr/v1/observations/{did}` | drop interest |
| `GET` | `/pmr/v1/observations/{did}/record` | latest declaration as CAR, with its `rev` |

Updates stream over `/pmr/v1/events`.

**Repo records MUST be exchanged as CAR** — the signed commit plus the
inclusion proof — never as JSON. Aggregations (follow counts, feeds, a
derived mutuals verdict) are CBOR and carry no authenticity claim; a
consumer MUST NOT treat them as authenticated. See
[`trust-model.md`](trust-model.md#p2--relayed-repo-records-are-car): JSON
discards the provenance that makes a record authoritative, and without it
an attacker can mint a well-formed declaration binding their own key to a
victim's DID.

A relay implementing observation is a CAR pass-through: it fetches the
record, stores the bytes and the `rev`, and forwards them, needing no CAR
parser and no MST walk. Verifying what it forwards is defense in depth
against a lying PDS, not a prerequisite.

### Push delegation (optional)

This section is deployment-specific and OPTIONAL. A relay whose platform
lets it deliver push directly implements none of it.

The problem it solves: mobile push entitlements are not transferable
between operators, so a self-hosted relay on such a platform cannot talk
to the platform's push service itself. The delegation shape:

- The client mints a **push grant** at the push service, authorized by
  that service's **registration realm**. Minting is the consent step:
  only the registration's owner can authorize delivery to it, closing the
  hijack — there is no way to mint a delegation pointed at someone else's
  device.
- The client **carries the grant to the relay** as part of its
  registration here, authorized by the anchor key. Server-to-server
  provisioning never happens; the credential travels client-carried, each
  hop authorized by the key that owns that hop.
- The relay **presents the grant** to cause a push. The grant is a
  symmetric key plus an identifier — a capability, not an identity — and
  authorization is an HMAC over the request under the grant key, not a
  bearer field: the same RFC 9421 profile used elsewhere, with an
  `hmac-sha256` algorithm.

Two custody rules are normative for any deployment that uses this path:

- The relay **MUST NOT hold a push token.** The grant points at a
  *registration*, so a token that rotates is a registration-side update
  and live grants keep resolving.
- The push payload **MUST be sealed** under a content key shared between
  the device and this relay, so the push service relays ciphertext it
  cannot read. The grant authorizes *delivery*; the content key protects
  *content*; neither substitutes for the other.

The payload carries the originating relay's host, so the device's
notification extension can select the right decryption context. A push
grant dies with logout, deregistration, or its own expiry, and can be
revoked individually without disturbing the registration, the mailbox
grants, or any other delegation.

### Capability document

`GET /.well-known/pmr-config.json` — public and cacheable. It advertises
limits, supported versions and encodings, and which functions this
deployment serves (a relay may serve observation only). A server MAY also
send it preemptively, for example alongside a challenge mint.

This is a *capability* document, served by a relay whose address you
already have. It is distinct from any future *discovery* mechanism — "does
a relay exist for this PDS, and where" — which is out of scope here.

## Freshness and replay

The property required is freshness with bounded replay, not use-once. The
challenge delivers the freshness half: a signature cannot exist before the
server issued the challenge it covers, and is valid only within that
challenge's TTL.

Use-once is deliberately not claimed. Strict single-use needs an atomic
consume that not every backend can provide, and best-effort consumption
narrows the replay window without closing it. Replay containment therefore
lives at the operation: **every challenge-reachable operation MUST be
replay-tolerant within the challenge TTL** — idempotent, content-addressed
and deduplicated, or independently sequenced. See
[`storage-consistency.md`](storage-consistency.md#2-challenge-freshness-not-exactly-once).

Puts are content-addressed and deduplicated; registration and grant
requests are idempotent or capped. Push-delegation submit is the one
operation that needs its own containment, since a delivered notification
is a user-visible side effect with no natural dedup.

`POST /pmr/v1/challenges` mints a challenge, bound to a realm and to the
identity or destination it will authorize. The mint is also where a server
declines, rate-limits, or applies policy.

## Error semantics

Three populations, and what each may learn is a security property:

| audience | answer |
|---|---|
| peer, grant put | `202` **always** — no other code, no timing difference |
| peer, pair put | `202`, or `429` + `Retry-After` when their own reservation is full, or `400` for a structurally malformed request decided on the request bytes alone. Nothing recipient-dependent — not whether the recipient is active, not whether they were blocked |
| owner | real, actionable codes — `401`, `404`, `409`, `413`, `429` — because client retry logic depends on distinguishing transient from terminal |

The dividing line is authorization and what per-sender reservation makes
self-referential: an owner gets diagnosis, an authenticated sender learns
only their own quota state, an anonymous sender gets acknowledgement.

The owner-facing error **body** format is
[not yet specified](#not-yet-specified).

## Limits are implementation-defined

Message and attachment size caps, attachment budgets, retention windows,
recovery-pool sizing, discard-window length, challenge TTL, and dormancy
policy are implementation-defined. The operator picks them and advertises
the peer-visible ones in the capability document. No constants appear in
this specification; none of them is something a peer or another relay
must agree on.

The recovery pool's sizing reasoning transfers even though its constants
do not:

- **Bound the pool by bytes, not by sender count.** Width is the property
  the pool exists to provide, and a sender-count cap rations exactly the
  thing the design says not to pre-judge. Smaller messages simply fit more
  senders.
- **Degrade per-sender depth before turning any sender away.** Under
  pressure, depth gives and width holds. A shallower pool doubles the
  senders that fit for the same storage.
- **Refuse only at true exhaustion** — byte cap reached with depth already
  minimal — and refuse senders not already present, keeping earlier
  arrivals rather than evicting them.
- **A threshold on distinct senders, not a cap, governs ordinary
  operation.** Crossing it triggers adjudication, which clears the pool.
  The byte cap binds only in the unanswered-wake case, where a device is
  offline, out of battery, or gone and nothing else regulates growth.
  Message retention expiry is the backstop for a permanently absent
  device.
- Sizing the threshold in senders, not storage, reflects what it governs:
  adjudication load — how many judgements the device is being asked for.

Whatever a deployment picks, the put still answers `202`.

## Not yet specified

- **Observation stream framing.** atproto's `subscribeRepos` framing —
  DAG-CBOR header/body frames over a WebSocket with a monotonic sequence
  cursor — is the direction to reach for first; a PDS operator already
  implements it. The frame vocabulary for delivery, acks, the
  queue-drained signal, and the pool notice is not fixed.
- **Owner-facing error bodies.** Two candidates:
  [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html)
  (`application/problem+json`) or XRPC's `{error, message}` shape.
  Undecided; whichever is chosen should apply everywhere.
- **Quota disclosure headers.** The per-sender reservation is rate-limit
  shaped, and the IETF `RateLimit-Limit` / `-Remaining` / `-Reset` family
  would express it directly. Permitted by the self-referential-disclosure
  rule — but if adopted, the blocked-sender path must produce consistent
  values, or the headers become an oracle.
- **Anti-replay nonce mechanics.** That the payload carries a
  recipient-tracked nonce is settled and normative; the concrete shape is
  not — nonce width, how long a recipient retains the seen-set before a
  session supersedes it, and what a device restoring from backup does
  about a seen-set it no longer holds.
- **COSE header labels** — registered versus private-use, for the sender
  DID, recipient DID, type marker, and nonce headers.
- **Version negotiation.** The capability document advertises versions;
  the rule for a client older or newer than its relay is undefined.
- **Batch shapes.** Acks batch today; whether grants, blocks, and
  observation subscriptions need batch forms or tolerate N requests is
  open.
- **Custom header field naming.** The reference implementation uses the
  field name `Germ-Next-Challenge`, shown above. Whether the published
  format keeps a vendor prefix is unsettled.
- **Content-address algorithm identifiers.** The shape is fixed — an
  algorithm identifier followed by the digest bytes — but the identifier
  assignments are not published here. SHA-256 is the only algorithm
  currently in use.
- **Concrete body schemas.** This document is an endpoint inventory and a
  set of rules about what may be disclosed, not an IDL. The field-level
  CBOR schemas for registration, grant issuance, ack batches, pool
  adjudication, and the capability document are not fixed here. The
  encoding rules that govern them — deterministic CBOR, `COSE_Key`, tag-1
  integer timestamps — are.

Settled by reaching for an existing standard: request signing
([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html)), request body
integrity ([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html),
requests only), key format and identity (`COSE_Key`,
[RFC 9679](https://www.rfc-editor.org/rfc/rfc9679.html) thumbprints),
message signing (`COSE_Sign1`,
[RFC 9052](https://www.rfc-editor.org/rfc/rfc9052.html)), ranged reads
(`Range`), quota refusal (`429` + `Retry-After`), capability discovery
([RFC 8615](https://datatracker.ietf.org/doc/html/rfc8615) `.well-known`),
pagination (`?cursor=`, the atproto convention), repo records (CAR),
deterministic encoding (RFC 8949 §4.2.1), header syntax
([RFC 9651](https://www.rfc-editor.org/rfc/rfc9651.html) Structured
Fields), and time (CBOR tag 1 / Structured Fields Date, integer seconds).
