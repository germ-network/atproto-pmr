/**
 * Challenge binding and redemption.
 *
 * The load-bearing property is that a challenge is bound AT MINT to a realm
 * and a subject, and cannot be spent on anything else — the client chooses
 * neither, so a challenge issued for one purpose cannot authorize another.
 *
 * Time is a parameter throughout; nothing here measures elapsed wall-clock.
 */
import { describe, expect, it } from "vitest"
import {
    consumeChallenge,
    decodeBinding,
    encodeBinding,
    mintChallenge,
    nextChallengeHeaderValue,
    type ChallengeBinding,
} from "../src/challenge"
import type { ChallengeStore } from "../src/storage"

const T0 = 1_760_000_000

/** An in-memory store, so these tests need no platform at all. */
function memoryStore(): ChallengeStore & { size(): number } {
    const rows = new Map<string, string>()
    return {
        async mint(challenge, boundTo) {
            rows.set(challenge, boundTo)
        },
        async consume(challenge) {
            const v = rows.get(challenge)
            if (v === undefined) return null
            rows.delete(challenge)
            return v
        },
        size: () => rows.size,
    }
}

let counter = 0
function deps(store: ChallengeStore, nowSeconds = T0) {
    return {
        store,
        config: { ttlSeconds: 600, byteLength: 32 },
        nowSeconds,
        // Deterministic, distinct per call.
        randomBytes: (n: number) => {
            counter += 1
            const b = new Uint8Array(n)
            new DataView(b.buffer).setUint32(0, counter)
            return b
        },
    }
}

const ANCHOR: ChallengeBinding = { realm: "anchor", subject: "did:plc:alice" }

describe("a challenge is bound at mint", () => {
    it("redeems for the binding it was issued for", async () => {
        const store = memoryStore()
        const { challenge, expiresAt } = await mintChallenge(ANCHOR, deps(store))
        expect(expiresAt).toBe(T0 + 600)

        const outcome = await consumeChallenge(challenge, ANCHOR, store, T0)
        expect(outcome.valid).toBe(true)
    })

    it("REFUSES across realms — the whole point of binding a realm", async () => {
        // The realms' revocation clocks are unrelated (registration-key
        // dormancy vs key-in-declaration), so a challenge that verified
        // across them would let one realm's lifetime authorize the other's
        // operations.
        const store = memoryStore()
        const { challenge } = await mintChallenge(ANCHOR, deps(store))

        const crossed = await consumeChallenge(
            challenge,
            { realm: "registration", subject: "did:plc:alice" },
            store,
            T0
        )
        expect(crossed.valid).toBe(false)
    })

    it("refuses a different subject in the same realm", async () => {
        const store = memoryStore()
        const { challenge } = await mintChallenge(ANCHOR, deps(store))

        const other = await consumeChallenge(
            challenge,
            { realm: "anchor", subject: "did:plc:mallory" },
            store,
            T0
        )
        expect(other.valid).toBe(false)
    })

    it("refuses a challenge that was never issued", async () => {
        const store = memoryStore()
        const outcome = await consumeChallenge("never-minted", ANCHOR, store, T0)
        expect(outcome.valid).toBe(false)
    })

    it("reports one undifferentiated failure for every rejection", async () => {
        // Distinguishing "unknown" from "expired" from "wrong realm" would
        // tell an attacker whether a challenge they hold was ever issued,
        // and wrong-realm would tell them a subject exists in the other.
        const store = memoryStore()
        const { challenge } = await mintChallenge(ANCHOR, deps(store))

        const unknown = await consumeChallenge("nope", ANCHOR, store, T0)
        const crossRealm = await consumeChallenge(
            challenge,
            { realm: "registration", subject: "did:plc:alice" },
            store,
            T0
        )
        expect(unknown).toEqual({ valid: false })
        expect(crossRealm).toEqual({ valid: false })
    })
})

describe("redemption spends the challenge", () => {
    it("a redeemed challenge does not redeem twice", async () => {
        const store = memoryStore()
        const { challenge } = await mintChallenge(ANCHOR, deps(store))

        expect((await consumeChallenge(challenge, ANCHOR, store, T0)).valid).toBe(true)
        expect((await consumeChallenge(challenge, ANCHOR, store, T0)).valid).toBe(false)
    })

    it("spends it even when the binding check then fails", async () => {
        // Delete-then-verify: the challenge is gone before anything about
        // the request is judged, so a redemption attempt cannot be retried
        // into a different verdict.
        const store = memoryStore()
        const { challenge } = await mintChallenge(ANCHOR, deps(store))

        await consumeChallenge(
            challenge,
            { realm: "anchor", subject: "did:plc:mallory" },
            store,
            T0
        )
        expect(store.size()).toBe(0)

        // Even the correct binding cannot rescue it now.
        expect((await consumeChallenge(challenge, ANCHOR, store, T0)).valid).toBe(false)
    })
})

describe("binding encoding", () => {
    it("round-trips", () => {
        const b: ChallengeBinding = { realm: "anchor", subject: "did:plc:x" }
        expect(decodeBinding(encodeBinding(b))).toEqual(b)
    })

    it("keeps the realm a prefix, so a subject containing the separator cannot forge one", () => {
        const sneaky: ChallengeBinding = {
            realm: "anchor",
            subject: "registration:did:plc:mallory",
        }
        const decoded = decodeBinding(encodeBinding(sneaky))
        expect(decoded?.realm).toBe("anchor")
        expect(decoded?.subject).toBe("registration:did:plc:mallory")
    })

    it("rejects an unknown realm rather than coercing it", () => {
        expect(decodeBinding("bogus:did:plc:x")).toBeNull()
        expect(decodeBinding("nocolon")).toBeNull()
        expect(decodeBinding(":empty-realm")).toBeNull()
    })
})

describe("the next-challenge header", () => {
    it("is a Structured Fields byte sequence with a Date-typed expiry", async () => {
        const store = memoryStore()
        const minted = await mintChallenge(ANCHOR, deps(store))
        const value = nextChallengeHeaderValue(minted)

        expect(value).toMatch(/^:[A-Za-z0-9+/]+=*:; expires=@\d+$/)
        expect(value.endsWith(`; expires=@${minted.expiresAt}`)).toBe(true)
    })

    it("emits standard base64 inside the colons, not base64url", async () => {
        // A conforming Structured Fields parser rejects base64url inside
        // `::`, so the wire-safe challenge has to be re-encoded here.
        const store = memoryStore()
        const minted = await mintChallenge(ANCHOR, {
            ...deps(store),
            randomBytes: () => new Uint8Array([0xfb, 0xff, 0xbf, 0x00]),
        })
        expect(minted.challenge).toContain("-")
        const value = nextChallengeHeaderValue(minted)
        expect(value).not.toContain("-")
        expect(value).not.toContain("_")
    })
})
