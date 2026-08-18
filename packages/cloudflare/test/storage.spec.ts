/**
 * The pair mailbox's storage semantics, which are security properties rather
 * than convenience choices:
 *
 *   - a provisioned mailbox REFUSES at capacity and keeps the oldest;
 *   - the recovery pool INVERTS that — it evicts and keeps the newest;
 *   - a blocked sender sees fill-then-drain and no stored bytes;
 *   - a discard lapses rather than standing;
 *   - a replayed envelope is a no-op, identically on the real, blocked, and
 *     pool paths, and a REFUSED attempt never consumes its nonce.
 *
 * Time is injected as a parameter throughout, so nothing here measures elapsed
 * wall-clock time.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { PMRObject } from "../src/pmr-object"
import type { MessageRef, Nonce } from "@germ-network/atproto-pmr-core"
import { inPMR, withSyntheticBehavior } from "./helpers"
import type { PMREnv } from "../src/env"

const testEnv = env as unknown as PMREnv

const T0 = 1_760_000_000

function ref(id: string, byteLength = 100): MessageRef {
    return { messageId: id, byteLength }
}

let nonceCounter = 0
/** A fresh, distinct nonce per call — tests that need a SHARED nonce (replay) pass one explicitly instead. */
function freshNonce(): Nonce {
    nonceCounter += 1
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, nonceCounter)
    return bytes
}

let counter = 0
function freshStub(): DurableObjectStub<PMRObject> {
    counter += 1
    const id = testEnv.pmrs.idFromName(`pmr-${counter}`)
    return testEnv.pmrs.get(id)
}

describe("a provisioned pair mailbox refuses when full", () => {
    it("accepts up to capacity, then refuses", async () => {
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            for (let i = 0; i < capacity; i++) {
                const result = await pmr.append("did:plc:alice", ref(`m${i}`), freshNonce(), T0)
                expect(result.outcome).toBe("appended")
            }
            const overflow = await pmr.append("did:plc:alice", ref("overflow"), freshNonce(), T0)
            expect(overflow.outcome).toBe("refused")
        })
    })

    it("keeps the OLDEST rather than evicting for the newest", async () => {
        // First contact is what these mailboxes are for, so the opening
        // message matters more than the most recent one. Accept-and-evict
        // would silently destroy mail a sender was told was accepted.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:alice", ref(`m${i}`), freshNonce(), T0)
            }
            await pmr.append("did:plc:alice", ref("overflow"), freshNonce(), T0)

            const queue = await pmr.list("did:plc:alice", 1000)
            expect(queue).toHaveLength(capacity)
            expect(queue[0].messageId).toBe("m0")
            expect(queue.map((r) => r.messageId)).not.toContain("overflow")
        })
    })

    it("draws retryAfter from the injected SyntheticBehavior, not a constant of its own", async () => {
        // Pins a real bug this design closes: retryAfter was once a bare
        // constant on the real path and a drawn value on the blocked one, so
        // a single 429 observation told an attacker which population they
        // were in — the exact oracle the simulation exists to close.
        //
        // The *distribution* is deployment-specific and deliberately
        // unpublished, so this asserts the property that IS normative: both
        // paths route through the same injected behavior. A sentinel value
        // no real implementation would return makes that unambiguous.
        const SENTINEL = T0 + 999_111
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)

        await inPMR(stub, async (pmr) => {
            withSyntheticBehavior(pmr, {
                nextRetryInstant: () => SENTINEL,
                advance: (stored, _now, cap) => {
                    const fill = stored?.fill ?? 0
                    return fill >= cap
                        ? { state: { fill }, accepted: false }
                        : { state: { fill: fill + 1 }, accepted: true }
                },
            })

            // Real mailbox, filled to capacity, then refused.
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:alice", ref(`m${i}`), freshNonce(), T0)
            }
            const realRefusal = await pmr.append(
                "did:plc:alice",
                ref("overflow"),
                freshNonce(),
                T0
            )
            if (realRefusal.outcome !== "refused") throw new Error("expected full")
            expect(realRefusal.retryAfter).toBe(SENTINEL)

            // Blocked sender, filled to capacity, then refused.
            await pmr.block("did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
            }
            const blockedRefusal = await pmr.append(
                "did:plc:mallory",
                ref("x"),
                freshNonce(),
                T0
            )
            if (blockedRefusal.outcome !== "refused") {
                throw new Error("expected synthetic full")
            }

            // The whole point: indistinguishable.
            expect(blockedRefusal.retryAfter).toBe(realRefusal.retryAfter)
        })
    })

    it("a real mailbox's retryAfter is stable across repeated refusals, like the blocked path's", async () => {
        // Same "anchor on the drain, not the fill" property the blocked
        // path already had — a persistent sender must not be able to move
        // the hint by refusing repeatedly, on EITHER path.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:alice", ref(`m${i}`), freshNonce(), T0)
            }
            const first = await pmr.append("did:plc:alice", ref("x"), freshNonce(), T0)
            if (first.outcome !== "refused") throw new Error("expected full")

            for (let i = 0; i < 5; i++) {
                const later = await pmr.append("did:plc:alice", ref("x"), freshNonce(), T0 + i)
                if (later.outcome !== "refused") throw new Error("expected full")
                expect(later.retryAfter).toBe(first.retryAfter)
            }
        })
    })
})

describe("a blocked sender cannot distinguish blocking from silence", () => {
    it("stores no bytes and keeps no queue", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("did:plc:mallory", ref("real"), freshNonce(), T0)
            await pmr.block("did:plc:mallory", T0)

            await pmr.append("did:plc:mallory", ref("m1"), freshNonce(), T0)
            await pmr.append("did:plc:mallory", ref("m2"), freshNonce(), T0)

            expect(await pmr.list("did:plc:mallory", 1000)).toEqual([])
        })
    })

    it("answers in the same shape a real mailbox does", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            const result = await pmr.append("did:plc:mallory", ref("m1"), freshNonce(), T0)
            // The DISPATCH OUTCOME — what's wire-visible via the caller's
            // response — is identical to a real mailbox's. `persistBody` is
            // internal bookkeeping never sent to any peer (see
            // storage/protocol.ts's AppendResult doc): it legitimately
            // differs here, and MUST — it's what keeps "no bytes stored for
            // a blocked sender" true without the caller ever learning which
            // branch ran.
            expect(result.outcome).toBe("appended")
            if (result.outcome !== "appended") throw new Error("unreachable")
            expect(result.persistBody).toBe(false)
        })
    })

    it("a REAL mailbox's accepted append sets persistBody: true", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const result = await pmr.append("did:plc:alice", ref("m1"), freshNonce(), T0)
            expect(result.outcome).toBe("appended")
            if (result.outcome !== "appended") throw new Error("unreachable")
            expect(result.persistBody).toBe(true)
        })
    })

    it("fills to capacity, then refuses with a future drain instant", async () => {
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                const r = await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
                expect(r.outcome).toBe("appended")
            }
            const refused = await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
            expect(refused.outcome).toBe("refused")
            if (refused.outcome !== "refused") throw new Error("unreachable")
            expect(refused.retryAfter).toBeGreaterThan(T0)
        })
    })

    it("drains once the stored instant passes, then accepts again", async () => {
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
            }
            const refused = await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
            if (refused.outcome !== "refused") throw new Error("expected full")

            const afterDrain = await pmr.append("did:plc:mallory", ref("x"), freshNonce(), refused.retryAfter)
            expect(afterDrain.outcome).toBe("appended")
        })
    })

    it("anchors the drain clock on the drain, not on the last fill", async () => {
        // Anchoring on the fill would let a persistent sender push the drain
        // back indefinitely — both wrong and a tell.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
            }
            const first = await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0)
            if (first.outcome !== "refused") throw new Error("expected full")

            // A sender that keeps pushing must not move the deadline.
            for (let i = 0; i < 5; i++) {
                await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0 + i)
            }
            const later = await pmr.append("did:plc:mallory", ref("x"), freshNonce(), T0 + 10)
            if (later.outcome !== "refused") throw new Error("expected full")
            expect(later.retryAfter).toBe(first.retryAfter)
        })
    })

    it("is reversible — unblocking restores an ordinary mailbox", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            await pmr.unblock("did:plc:mallory")
            await pmr.append("did:plc:mallory", ref("m1"), freshNonce(), T0)
            const queue = await pmr.list("did:plc:mallory", 1000)
            expect(queue.map((r) => r.messageId)).toEqual(["m1"])
        })
    })

    it("lists the blocked DIDs from the block records themselves", async () => {
        // The listing is a projection of the block markers' own keys, so it
        // cannot disagree with who is actually blocked — which a side table
        // mapping keys back to DIDs could. Colons in the DID are the case
        // worth pinning: the prefix is stripped by length, never split on.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            await pmr.block("did:web:relay.example:users:eve", T0)
            expect((await pmr.listBlocked()).sort()).toEqual([
                "did:plc:mallory",
                "did:web:relay.example:users:eve",
            ])

            await pmr.unblock("did:plc:mallory")
            expect(await pmr.listBlocked()).toEqual([
                "did:web:relay.example:users:eve",
            ])
        })
    })

    it("does not list a sender who merely has a mailbox or pool entry", async () => {
        // `syn:` is the blocked family; nothing else may leak into it.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("did:plc:alice", ref("m1"), freshNonce(), T0)
            await pmr.appendToPool(
                "did:plc:stranger",
                ref("m2"),
                freshNonce(),
                T0
            )
            expect(await pmr.listBlocked()).toEqual([])
        })
    })
})

describe("anti-replay: nonce checked and recorded atomically with append", () => {
    it("a replayed nonce on a REAL mailbox is a no-op, not a second entry", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const nonce = freshNonce()
            const first = await pmr.append("did:plc:alice", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("appended")

            // SAME nonce — a captured envelope resubmitted.
            const replay = await pmr.append(
                "did:plc:alice",
                ref("m1-replay-attempt"),
                nonce,
                T0
            )
            expect(replay.outcome).toBe("duplicate")

            const queue = await pmr.list("did:plc:alice", 10)
            expect(queue).toHaveLength(1)
            expect(queue[0].messageId).toBe("m1")
        })
    })

    it("the closure/oracle probe: replaying past capacity never flips a REAL mailbox to refused", async () => {
        // wire-api.md's uniform-202 contract for pair puts: 202, or 429 for
        // the sender's OWN reservation being full — replay must not be able
        // to manufacture either transition on its own.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            const nonce = freshNonce()
            const first = await pmr.append("did:plc:alice", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("appended")

            // Replay the SAME envelope far more times than capacity.
            for (let i = 0; i < capacity * 3; i++) {
                const replay = await pmr.append("did:plc:alice", ref("m1"), nonce, T0)
                expect(replay.outcome).toBe("duplicate")
            }

            // The mailbox never filled from replay — fresh senders still fit.
            for (let i = 0; i < capacity - 1; i++) {
                const r = await pmr.append("did:plc:alice", ref(`fresh${i}`), freshNonce(), T0)
                expect(r.outcome).toBe("appended")
            }
        })
    })

    it("the closure/oracle probe: replaying past capacity never flips a BLOCKED mailbox to refused either", async () => {
        // Without nonce parity on the blocked path, a replay would advance
        // the synthetic state and eventually flip 202 -> 429 — a working
        // oracle for blocked-vs-real, since a real mailbox's replay (above)
        // never does that.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("did:plc:mallory", T0)
            const nonce = freshNonce()
            const first = await pmr.append("did:plc:mallory", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("appended")

            for (let i = 0; i < capacity * 3; i++) {
                const replay = await pmr.append("did:plc:mallory", ref("m1"), nonce, T0)
                expect(replay.outcome).toBe("duplicate")
            }

            // Still has real headroom left — replay consumed none of it.
            for (let i = 0; i < capacity - 1; i++) {
                const r = await pmr.append("did:plc:mallory", ref(`fresh${i}`), freshNonce(), T0)
                expect(r.outcome).toBe("appended")
            }
        })
    })

    it("a REFUSED attempt does not consume its nonce, so a legitimate retry after drain succeeds", async () => {
        // The retry story 429 + Retry-After is supposed to enable: a client
        // resubmits the IDENTICAL signed envelope (same nonce) once room
        // exists. If refusal recorded the nonce, this retry would be
        // misread as a replay forever and the message would never land.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            for (let i = 0; i < capacity; i++) {
                await pmr.append("did:plc:alice", ref(`m${i}`), freshNonce(), T0)
            }

            const retryNonce = freshNonce()
            const refused = await pmr.append("did:plc:alice", ref("retryme"), retryNonce, T0)
            expect(refused.outcome).toBe("refused")

            // Drain one slot, then retry the SAME envelope/nonce.
            await pmr.remove("did:plc:alice", "m0")
            const retried = await pmr.append("did:plc:alice", ref("retryme"), retryNonce, T0)
            expect(retried.outcome).toBe("appended")
        })
    })

    it("a replayed nonce in the POOL is a no-op, not a second entry", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const nonce = freshNonce()
            const first = await pmr.appendToPool("did:plc:stranger", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("pooled")

            const replay = await pmr.appendToPool("did:plc:stranger", ref("m1"), nonce, T0)
            expect(replay.outcome).toBe("duplicate")
        })
    })

    it("shares its nonce set across the pool and the pair mailbox for the same key", async () => {
        // A nonce is a property of (sender, envelope), not of which storage
        // tier absorbed it — otherwise a sender who gets provisioned mid-flight
        // could replay the same pooled envelope into their new mailbox.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const nonce = freshNonce()
            const pooled = await pmr.appendToPool("did:plc:stranger", ref("m1"), nonce, T0)
            expect(pooled.outcome).toBe("pooled")

            // Same sender is now provisioned; the SAME envelope replays.
            const replay = await pmr.append("did:plc:stranger", ref("m1"), nonce, T0)
            expect(replay.outcome).toBe("duplicate")
        })
    })
})

describe("the recovery pool inverts the provisioned mailbox's policy", () => {
    it("keeps the NEWEST under depth pressure", async () => {
        // The freshest attempt carries current state; stale attempts are
        // worthless. This is the opposite of the provisioned mailbox and must
        // not be implemented by reusing its append with a different cap.
        const stub = freshStub()
        const depth = parseInt(testEnv.POOL_DEPTH_PER_SENDER)
        await inPMR(stub, async (pmr) => {
            for (let i = 0; i < depth + 3; i++) {
                const r = await pmr.appendToPool("did:plc:stranger", ref(`m${i}`), freshNonce(), T0)
                expect(r.outcome).toBe("pooled")
            }
            const senders = await pmr.poolSenders()
            expect(senders.map((s) => s.did)).toContain("did:plc:stranger")
            // Adjudication must name a sender the device can decide about.
            expect(senders[0].did).toBe("did:plc:stranger")
            expect(senders[0].count).toBe(depth)
        })
    })

    it("never refuses a sender that already holds entries", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const big = parseInt(testEnv.POOL_CAP_BYTES)
            await pmr.appendToPool("did:plc:recovering", ref("first", big), freshNonce(), T0)
            const second = await pmr.appendToPool("did:plc:recovering", ref("second"), freshNonce(), T0)
            expect(second.outcome).toBe("pooled")
        })
    })

    it("turns away only unknown senders at true exhaustion", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const big = parseInt(testEnv.POOL_CAP_BYTES)
            await pmr.appendToPool("did:plc:early", ref("fills-the-pool", big), freshNonce(), T0)
            const late = await pmr.appendToPool("did:plc:late", ref("m1"), freshNonce(), T0)
            expect(late.outcome).toBe("exhausted")
        })
    })

    it("lists senders without exposing bodies", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool("did:plc:a", ref("m1"), freshNonce(), T0)
            await pmr.appendToPool("did:plc:b", ref("m2"), freshNonce(), T0)
            const senders = (await pmr.poolSenders()).map((s) => s.did)
            expect(senders.sort()).toEqual(["did:plc:a", "did:plc:b"])
        })
    })

    it("recovers each sender's DID exactly, colons and all", async () => {
        // The listing reads the pool's own keys rather than joining against
        // a table that records the DID separately, so there is no entry
        // whose DID can go missing and leave the sender unadjudicable. A
        // `did:web` with path segments is the shape that would break a
        // prefix stripped by splitting on `:` instead of by length.
        const stub = freshStub()
        const did = "did:web:relay.example:users:eve"
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool(did, ref("m1"), freshNonce(), T0)
            await pmr.appendToPool(did, ref("m2"), freshNonce(), T0)
            expect(await pmr.poolSenders()).toEqual([{ did, count: 2 }])

            // And the recovered DID round-trips as a key: adjudicating with
            // exactly what the listing returned finds the entries.
            const moved = await pmr.provisionFromPool(did, T0)
            expect(moved.map((r) => r.messageId)).toEqual(["m1", "m2"])
        })
    })

    it("does not mistake the pool byte counter for a pooled sender", async () => {
        // `poolBytes` sits one character from the `pool:` family.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool("did:plc:a", ref("m1"), freshNonce(), T0)
            expect(await pmr.poolSenders()).toEqual([
                { did: "did:plc:a", count: 1 },
            ])
        })
    })
})

describe("discard is time-bounded, not standing", () => {
    it("suppresses inside the window and lapses after it", async () => {
        // A permanent discard would draw a permanent consequence from a
        // judgement made on incomplete information — the device discards a DID
        // it does not recognise *at that moment*, and the pool exists for
        // exactly the case where its knowledge is behind.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.setDiscarded("did:plc:stranger", T0 + 100)
            expect(await pmr.isDiscarded("did:plc:stranger", T0)).toBe(true)
            expect(await pmr.isDiscarded("did:plc:stranger", T0 + 101)).toBe(false)
        })
    })

    it("appendToPool answers pooled/persistBody:false for a discarded sender, storing nothing", async () => {
        // Pins the discard-RPC-count fix: the discard check runs INSIDE
        // appendToPool now, not as a separate isDiscarded call the Worker
        // branches on before deciding whether to call this at all.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.setDiscarded("did:plc:stranger", T0 + 100)
            const result = await pmr.appendToPool("did:plc:stranger", ref("m1"), freshNonce(), T0)
            expect(result).toEqual({ outcome: "pooled", persistBody: false })
            // Never actually entered — poolSenders() must not list it.
            expect((await pmr.poolSenders()).map((s) => s.did)).not.toContain("did:plc:stranger")
        })
    })

    it("a fresh envelope succeeds once the discard window lapses, same nonce or not", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.setDiscarded("did:plc:stranger", T0 + 100)
            const nonce = freshNonce()
            const discarded = await pmr.appendToPool("did:plc:stranger", ref("m1"), nonce, T0)
            if (discarded.outcome !== "pooled") throw new Error("unreachable")
            expect(discarded.persistBody).toBe(false)

            // Discard didn't consume the nonce either, matching `refused`'s
            // reasoning: a retry once the window lapses is evaluated fresh.
            const afterLapse = await pmr.appendToPool("did:plc:stranger", ref("m1"), nonce, T0 + 101)
            expect(afterLapse).toEqual({ outcome: "pooled", persistBody: true })
            expect((await pmr.poolSenders()).map((s) => s.did)).toContain("did:plc:stranger")
        })
    })
})

describe("removal is idempotent", () => {
    it("succeeds on an already-removed record", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("did:plc:alice", ref("m1"), freshNonce(), T0)
            await pmr.remove("did:plc:alice", "m1")
            await pmr.remove("did:plc:alice", "m1")
            await pmr.remove("nobody", "m1")
            expect(await pmr.list("did:plc:alice", 10)).toEqual([])
        })
    })
})

describe("blocking a pooled sender closes both surfaces", () => {
    it("purges their pool entries, so adjudication cannot resurrect them", async () => {
        // Otherwise a sender pooled BEFORE being blocked still shows up in
        // the owner's pool listing, and provisioning them would create a
        // live mailbox holding a blocked sender's messages.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool(
                "did:plc:mallory",
                ref("m1", 500),
                freshNonce(),
                T0
            )
            expect((await pmr.poolSenders()).map((s) => s.did)).toContain("did:plc:mallory")

            await pmr.block("did:plc:mallory", T0)

            expect(await pmr.poolSenders()).toEqual([])
            // And provisioning is refused even if a stale key reaches it.
            expect(await pmr.provisionFromPool("did:plc:mallory", T0)).toEqual([])
            expect(await pmr.list("did:plc:mallory", 10)).toEqual([])
        })
    })

    it("returns the purged bytes to the pool budget", async () => {
        // A blocked sender's bytes must not permanently consume the cap —
        // that would let repeated block cycles starve the pool's width.
        const stub = freshStub()
        const cap = parseInt(testEnv.POOL_CAP_BYTES)
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool("did:plc:a", ref("big", cap), freshNonce(), T0)
            // Pool is now at capacity: a new sender is turned away.
            expect(
                (await pmr.appendToPool("did:plc:b", ref("m"), freshNonce(), T0))
                    .outcome
            ).toBe("exhausted")

            await pmr.block("did:plc:a", T0)

            // Budget released, so an unrelated sender fits again.
            expect(
                (await pmr.appendToPool("did:plc:c", ref("m"), freshNonce(), T0))
                    .outcome
            ).toBe("pooled")
        })
    })
})

describe("grant mailboxes reuse the pair mailbox's append/list/remove", () => {
    it("accepts, lists, and removes exactly as a pair mailbox does — the key is just an address instead of a DID", async () => {
        const stub = freshStub()
        const address = "grant-address-000000000000000000000000000"
        await inPMR(stub, async (pmr) => {
            const result = await pmr.append(
                address,
                ref("m1"),
                freshNonce(),
                T0
            )
            expect(result).toEqual({ outcome: "appended", persistBody: true })
            expect((await pmr.list(address, 10)).map((r) => r.messageId)).toEqual([
                "m1",
            ])
            await pmr.remove(address, "m1")
            expect(await pmr.list(address, 10)).toEqual([])
        })
    })

    it("a content-hash nonce makes replaying the identical message a no-op", async () => {
        // This is the mechanism `handleGrantPut` relies on in place of a
        // per-sender anti-replay nonce: the same bytes hashed the same way
        // land the same "nonce", so a resend of an already-appended message
        // is `duplicate`, not a second queue entry.
        const stub = freshStub()
        const address = "grant-address-111111111111111111111111111"
        const contentHash = new Uint8Array(32).fill(9)
        await inPMR(stub, async (pmr) => {
            const first = await pmr.append(address, ref("m1"), contentHash, T0)
            expect(first.outcome).toBe("appended")
            const replay = await pmr.append(address, ref("m1"), contentHash, T0)
            expect(replay.outcome).toBe("duplicate")
            expect(await pmr.list(address, 10)).toHaveLength(1)
        })
    })
})

describe("PMRObject grant records", () => {
    it("issues, lists, and reads back a grant — never the authKey", async () => {
        const stub = freshStub()
        const address = "grant-address-222222222222222222222222222"
        await inPMR(stub, async (pmr) => {
            await pmr.issueGrant(address, new Uint8Array(32).fill(1), T0 + 3600)

            const grants = await pmr.listGrants()
            expect(grants).toEqual([{ address, expiresAt: T0 + 3600, closed: false }])
            // No `key`/`authKey` field anywhere in what's listed back.
            expect(Object.keys(grants[0]).sort()).toEqual([
                "address",
                "closed",
                "expiresAt",
            ])

            expect(await pmr.getGrant(address)).toEqual({
                address,
                expiresAt: T0 + 3600,
                closed: false,
            })
        })
    })

    it("getGrant is null for an address this owner never issued", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            expect(await pmr.getGrant("never-issued")).toBeNull()
        })
    })

    it("setGrantClosed is reversible and a no-op on an unknown address", async () => {
        const stub = freshStub()
        const address = "grant-address-333333333333333333333333333"
        await inPMR(stub, async (pmr) => {
            await pmr.issueGrant(address, new Uint8Array(32), T0 + 3600)

            await pmr.setGrantClosed(address, true)
            expect((await pmr.getGrant(address))!.closed).toBe(true)

            await pmr.setGrantClosed(address, false)
            expect((await pmr.getGrant(address))!.closed).toBe(false)

            // Never issued: must not throw and must not create a row.
            await pmr.setGrantClosed("never-issued", true)
            expect(await pmr.getGrant("never-issued")).toBeNull()
        })
    })

    it("invalidateGrant removes the record permanently", async () => {
        const stub = freshStub()
        const address = "grant-address-444444444444444444444444444"
        await inPMR(stub, async (pmr) => {
            await pmr.issueGrant(address, new Uint8Array(32), T0 + 3600)
            await pmr.invalidateGrant(address)
            expect(await pmr.getGrant(address)).toBeNull()
            expect(await pmr.listGrants()).toEqual([])

            // Idempotent.
            await pmr.invalidateGrant(address)
        })
    })

    it("lists multiple grants without leaking into the pool/synthetic families", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.issueGrant("addr-a", new Uint8Array(32), T0 + 100)
            await pmr.issueGrant("addr-b", new Uint8Array(32), T0 + 200)
            await pmr.block("did:plc:unrelated", T0)
            await pmr.appendToPool(
                "did:plc:unrelated-pool",
                ref("m"),
                freshNonce(),
                T0
            )

            const addresses = (await pmr.listGrants()).map((g) => g.address).sort()
            expect(addresses).toEqual(["addr-a", "addr-b"])
        })
    })
})

describe("openMailboxes — reconnect-drain's primitive", () => {
    it("returns pair and grant mailboxes alike, with their queued messages", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("did:plc:alice", ref("m1"), freshNonce(), T0)
            await pmr.append("grant:address-xyz", ref("m2"), freshNonce(), T0)

            const page = await pmr.openMailboxes(null, 100)
            expect(page.nextCursor).toBeNull()
            const byKey = new Map(page.entries.map((e) => [e.key, e.messages]))
            expect(byKey.get("did:plc:alice")?.map((r) => r.messageId)).toEqual(["m1"])
            expect(byKey.get("grant:address-xyz")?.map((r) => r.messageId)).toEqual([
                "m2",
            ])
        })
    })

    it("omits a provisioned mailbox with nothing queued", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            // provisionFromPool's empty-sender case writes an empty queue.
            await pmr.provisionFromPool("did:plc:empty", T0)
            const page = await pmr.openMailboxes(null, 100)
            expect(page.entries).toEqual([])
        })
    })

    it("does not leak pool or synthetic-block state into the listing", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool("did:plc:pooled", ref("m"), freshNonce(), T0)
            await pmr.block("did:plc:blocked", T0)
            const page = await pmr.openMailboxes(null, 100)
            expect(page.entries).toEqual([])
        })
    })

    it("paginates via a cursor, and a page filtered to empty still advances", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            // "a" has content, "b" is empty (provisioned via the pool path),
            // "c" has content — a filtered-empty middle page must not stall.
            await pmr.append("did:plc:a", ref("m1"), freshNonce(), T0)
            await pmr.provisionFromPool("did:plc:b", T0)
            await pmr.append("did:plc:c", ref("m2"), freshNonce(), T0)

            const first = await pmr.openMailboxes(null, 1)
            expect(first.entries.map((e) => e.key)).toEqual(["did:plc:a"])
            expect(first.nextCursor).not.toBeNull()

            const second = await pmr.openMailboxes(first.nextCursor, 1)
            expect(second.entries).toEqual([]) // "b" filtered out
            expect(second.nextCursor).not.toBeNull()

            const third = await pmr.openMailboxes(second.nextCursor, 1)
            expect(third.entries.map((e) => e.key)).toEqual(["did:plc:c"])
            expect(third.nextCursor).toBeNull()
        })
    })

    it("a forged cursor cannot escape the mailbox key family into pool/synthetic/grant-row state", async () => {
        // The cursor is now a wire-visible value (GER-2214's REST catch-up
        // publishes it verbatim), so a caller can hand back an arbitrary
        // string, not just one this object issued. `openMailboxes` passes
        // it straight to `startAfter` — safe only because `prefix` is
        // ALSO given and constrains every returned key regardless of
        // where `startAfter` sorts. This pins that composition rather
        // than assuming it.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("did:plc:a", ref("m1"), freshNonce(), T0)
            await pmr.appendToPool("did:plc:pooled", ref("m2"), freshNonce(), T0)
            await pmr.block("did:plc:blocked", T0)

            // Sorts after every real "mbox:" key and lands inside the
            // "pool:"/"syn:" key ranges — the forgery a caller who read the
            // key layout off a real cursor could construct.
            const forged = "pool:"
            const page = await pmr.openMailboxes(forged, 100)
            expect(page.entries).toEqual([])
            expect(page.nextCursor).toBeNull()
        })
    })

    it("a forged cursor from BEFORE every real key still returns only mailbox entries", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("did:plc:a", ref("m1"), freshNonce(), T0)
            await pmr.appendToPool("did:plc:pooled", ref("m2"), freshNonce(), T0)

            // "grantrow:" sorts BEFORE "mbox:", so startAfter alone (with
            // no prefix filter) would include the grant-row family too.
            const forged = "grantrow:"
            const page = await pmr.openMailboxes(forged, 100)
            expect(page.entries.map((e) => e.key)).toEqual(["did:plc:a"])
        })
    })

    it("a DID containing ':' round-trips through the prefix strip", async () => {
        const stub = freshStub()
        const did = "did:web:relay.example:users:eve"
        await inPMR(stub, async (pmr) => {
            await pmr.append(did, ref("m1"), freshNonce(), T0)
            const page = await pmr.openMailboxes(null, 100)
            expect(page.entries).toEqual([{ key: did, messages: [ref("m1")] }])
        })
    })
})
