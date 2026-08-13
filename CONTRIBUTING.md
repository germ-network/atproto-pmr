# Contributing

Contributions are welcomed and encouraged.

To give clarity of what is expected of our members, Germ has adopted the
code of conduct defined by the Contributor Covenant. This document is used
across many open source communities, and we think it articulates our values
well. For more, see the [Code of Conduct](./CODE_OF_CONDUCT.md).

## What this repository is

An interop specification and a reference storage connector. Two kinds of
contribution are especially useful:

- **Specification issues** — an ambiguity, a requirement that cannot be
  satisfied as written, or a place where two readings would produce
  non-interoperating implementations. The
  ["Not yet specified"](spec/README.md#not-yet-specified) sections list
  what is known to be open; anything outside those is worth reporting.
- **Independent implementation reports** — what was unclear, what you had
  to guess, and what your backend made hard. That feedback is the main
  thing that turns a first draft into a specification.

Where the specification and the reference connector disagree, the
specification is authoritative and the connector has a bug.

## Reporting bugs

Please report them using
[GitHub Issues](https://github.com/germ-network/atproto-pmr/issues).
Before opening a new one, take a moment to
[browse existing issues](https://github.com/germ-network/atproto-pmr/issues)
to reduce the chance of a duplicate.

For anything with a security impact — a way to distinguish a blocked sender
from an unanswered one, an oracle in a response or its timing, or a
verification step that can be skipped without detection — please **do not**
open a public issue. Report it privately via
[GitHub's security advisory flow](https://github.com/germ-network/atproto-pmr/security/advisories/new).

## Changesets

We use [Changesets](https://github.com/changesets/changesets) to document
changes and releases. Please
[generate a changeset](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md)
for your pull requests.
