# atproto-pmr

An **Atproto Personal Messaging Relay** — a persistently online, weakly
trusted delegate of an [atproto](https://atproto.com/) DID that operates
end-to-end encrypted mailboxes and observes atproto state on that DID's
behalf.

This repository is the **interop specification** plus the packages that
implement it, published so that PDS operators and self-hosters can run
their own relay and interoperate. The specification is the contract: where
it and the code disagree, the specification is right and the code has a
bug.

| package | what it is |
|---|---|
| [`packages/core`](packages/core) | protocol logic over injected seams — request verification, the pair-put algorithm, declaration resolution, content addressing. No platform assumptions; its tests run with no Workers runtime |
| [`packages/cloudflare`](packages/cloudflare) | the storage contract implemented on Durable Objects and KV |

Both are consumed as **git dependencies** rather than from npm:

```
"@germ-network/atproto-pmr-core":
    "github:germ-network/atproto-pmr#path:/packages/core"
```

`core` is a **peer** dependency of `cloudflare` — install both, from the
same source, so there is exactly one copy and the types unify.

**The blocked-sender behavior is deliberately not shipped here.**
`SyntheticBehavior` is an interface whose only implementation is a
development-only default that says, loudly, that it is unfit to deploy.
Supply your own, and do not publish it: a published simulation is a
fingerprint an attacker can test a relay against. See
[`packages/core/src/synthetic.ts`](packages/core/src/synthetic.ts).

## Start here

**[`spec/README.md`](spec/README.md)** — what a relay is, where to start,
the normative/implementation-defined split, and a conformance summary.

| document | covers |
|---|---|
| [`spec/wire-api.md`](spec/wire-api.md) | the normative wire surface — request authentication, key material, endpoint inventory, the pair-put payload and its verification algorithm, error semantics, the closure exception |
| [`spec/storage-consistency.md`](spec/storage-consistency.md) | the storage consistency contract, stated backend-neutrally |
| [`spec/trust-model.md`](spec/trust-model.md) | what a relay is trusted with, what it necessarily learns, what a malicious one can do |

[`reference/`](reference/) is a Cloudflare Durable Object implementation of
the storage contract — the storage layer only, not a complete relay, and
not normative. Its value for an adopter on a different backend is that it
marks which requirements a serialized execution model provides for free and
which you have to supply deliberately. It ships a **placeholder you must
replace**; see [`reference/README.md`](reference/README.md).

## Two things to know before implementing

**A put to a grant mailbox answers `202` for every outcome** — unknown
address, closed address, live address, bad tag — identical in content *and
in time*, so that a blocked sender cannot discover they were blocked. This
looks like a bug in review; it is the property the design exists to
protect. See
[the closure exception](spec/wire-api.md#the-closure-exception).

**The client half is not optional.** Several guarantees hold only because
the device verifies rather than trusts: the pair-put verification
algorithm, CAR-verified declarations, and re-derivation of grant addresses.
A client that skips them removes the guarantee rather than degrading it.

## Status

**First public draft.** Unsettled edges are listed in each document's "Not
yet specified" section. Two of them — the grant address derivation and the
concrete body schemas — currently block a second implementation from
interoperating, and need publication with test vectors first.

## Contributing and Collaboration

We welcome contributions!

Please follow our [guidelines for contributing code](./CONTRIBUTING.md).

To give clarity of what is expected of our members, Germ has adopted the
code of conduct defined by the Contributor Covenant. This document is used
across many open source communities, and we think it articulates our values
well. For more, see the [Code of Conduct](./CODE_OF_CONDUCT.md).
