/**
 * The one inbox path's key prefixes.
 *
 * These tests carry more weight than they look like they should: this
 * package's `tsconfig` typechecks `src` only, so the `MailboxKey` template
 * type catches a malformed key in library code and catches nothing at all
 * in a test or in an adopter who skips `tsc`. Runtime is the only place the
 * asymmetry between the two arms is actually enforced.
 */
import { describe, expect, it } from "vitest"
import {
    asMailboxKey,
    asPairMailboxKey,
    grantMailboxKey,
    isPairMailboxKey,
    parseMailboxKey,
} from "../src/mailbox-key"

describe("parseMailboxKey", () => {
    it("returns a DID VERBATIM — the key is the DID, with nothing to strip", () => {
        // The whole asymmetry in one assertion. Stripping `did:` here would
        // hand routing `plc:alice`, which resolves to nobody.
        expect(parseMailboxKey("did:plc:alice")).toEqual({
            kind: "did",
            did: "did:plc:alice",
        })
    })

    it("strips `grant:` to recover the address the directory is keyed by", () => {
        expect(parseMailboxKey("grant:abc123")).toEqual({
            kind: "grant",
            address: "abc123",
        })
    })

    it("reads did:grant:… as a DID, not as a grant", () => {
        // A DID method could be named anything, including `grant`. The
        // `did:` prefix is checked first, so there is no ambiguity to
        // resolve — but only if the order stays this way.
        expect(parseMailboxKey("did:grant:xyz")).toEqual({
            kind: "did",
            did: "did:grant:xyz",
        })
    })

    it("rejects a key matching neither prefix", () => {
        // A bare grant address, which is exactly what a client that forgot
        // to prefix would send.
        expect(() => parseMailboxKey("abc123")).toThrow(/must begin with/)
        expect(() => parseMailboxKey("")).toThrow(/must begin with/)
    })

    it("does not accept a prefix that merely starts the same way", () => {
        expect(() => parseMailboxKey("didsomething")).toThrow()
        expect(() => parseMailboxKey("grants:abc")).toThrow()
    })
})

describe("grantMailboxKey", () => {
    it("round-trips with parseMailboxKey", () => {
        const address = "AbC-123_xyz"
        const parsed = parseMailboxKey(grantMailboxKey(address))
        expect(parsed).toEqual({ kind: "grant", address })
    })

    it("survives an address containing a colon", () => {
        // Nothing forbids one, and every reader slices a fixed prefix
        // length rather than splitting — so this must not lose the tail.
        const parsed = parseMailboxKey(grantMailboxKey("a:b:c"))
        expect(parsed).toEqual({ kind: "grant", address: "a:b:c" })
    })
})

describe("the narrowing helpers", () => {
    it("isPairMailboxKey accepts a DID and rejects a grant key", () => {
        expect(isPairMailboxKey("did:plc:alice")).toBe(true)
        expect(isPairMailboxKey("grant:abc")).toBe(false)
    })

    it("asPairMailboxKey refuses a grant key", () => {
        // Pair-only operations — blocking, the recovery pool — must not
        // silently accept an address. An owner blocks a sender DID and
        // suppresses a grant by closing it; the two are not interchangeable.
        expect(() => asPairMailboxKey("grant:abc")).toThrow(/not a DID/)
    })

    it("asMailboxKey accepts either kind and rejects neither", () => {
        expect(asMailboxKey("did:plc:alice")).toBe("did:plc:alice")
        expect(asMailboxKey("grant:abc")).toBe("grant:abc")
        expect(() => asMailboxKey("abc")).toThrow()
    })
})
