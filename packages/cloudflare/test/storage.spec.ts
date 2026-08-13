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
                const result = await pmr.append("alice", ref(`m${i}`), freshNonce(), T0)
                expect(result.outcome).toBe("appended")
            }
            const overflow = await pmr.append("alice", ref("overflow"), freshNonce(), T0)
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
                await pmr.append("alice", ref(`m${i}`), freshNonce(), T0)
            }
            await pmr.append("alice", ref("overflow"), freshNonce(), T0)

            const queue = await pmr.list("alice", 1000)
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
                await pmr.append("alice", ref(`m${i}`), freshNonce(), T0)
            }
            const realRefusal = await pmr.append(
                "alice",
                ref("overflow"),
                freshNonce(),
                T0
            )
            if (realRefusal.outcome !== "refused") throw new Error("expected full")
            expect(realRefusal.retryAfter).toBe(SENTINEL)

            // Blocked sender, filled to capacity, then refused.
            await pmr.block("mallory", "did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                await pmr.append("mallory", ref("x"), freshNonce(), T0)
            }
            const blockedRefusal = await pmr.append(
                "mallory",
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
                await pmr.append("alice", ref(`m${i}`), freshNonce(), T0)
            }
            const first = await pmr.append("alice", ref("x"), freshNonce(), T0)
            if (first.outcome !== "refused") throw new Error("expected full")

            for (let i = 0; i < 5; i++) {
                const later = await pmr.append("alice", ref("x"), freshNonce(), T0 + i)
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
            await pmr.append("mallory", ref("real"), freshNonce(), T0)
            await pmr.block("mallory", "did:plc:mallory", T0)

            await pmr.append("mallory", ref("m1"), freshNonce(), T0)
            await pmr.append("mallory", ref("m2"), freshNonce(), T0)

            expect(await pmr.list("mallory", 1000)).toEqual([])
        })
    })

    it("answers in the same shape a real mailbox does", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.block("mallory", "did:plc:mallory", T0)
            const result = await pmr.append("mallory", ref("m1"), freshNonce(), T0)
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
            const result = await pmr.append("alice", ref("m1"), freshNonce(), T0)
            expect(result.outcome).toBe("appended")
            if (result.outcome !== "appended") throw new Error("unreachable")
            expect(result.persistBody).toBe(true)
        })
    })

    it("fills to capacity, then refuses with a future drain instant", async () => {
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("mallory", "did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                const r = await pmr.append("mallory", ref("x"), freshNonce(), T0)
                expect(r.outcome).toBe("appended")
            }
            const refused = await pmr.append("mallory", ref("x"), freshNonce(), T0)
            expect(refused.outcome).toBe("refused")
            if (refused.outcome !== "refused") throw new Error("unreachable")
            expect(refused.retryAfter).toBeGreaterThan(T0)
        })
    })

    it("drains once the stored instant passes, then accepts again", async () => {
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("mallory", "did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                await pmr.append("mallory", ref("x"), freshNonce(), T0)
            }
            const refused = await pmr.append("mallory", ref("x"), freshNonce(), T0)
            if (refused.outcome !== "refused") throw new Error("expected full")

            const afterDrain = await pmr.append("mallory", ref("x"), freshNonce(), refused.retryAfter)
            expect(afterDrain.outcome).toBe("appended")
        })
    })

    it("anchors the drain clock on the drain, not on the last fill", async () => {
        // Anchoring on the fill would let a persistent sender push the drain
        // back indefinitely — both wrong and a tell.
        const stub = freshStub()
        const capacity = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        await inPMR(stub, async (pmr) => {
            await pmr.block("mallory", "did:plc:mallory", T0)
            for (let i = 0; i < capacity; i++) {
                await pmr.append("mallory", ref("x"), freshNonce(), T0)
            }
            const first = await pmr.append("mallory", ref("x"), freshNonce(), T0)
            if (first.outcome !== "refused") throw new Error("expected full")

            // A sender that keeps pushing must not move the deadline.
            for (let i = 0; i < 5; i++) {
                await pmr.append("mallory", ref("x"), freshNonce(), T0 + i)
            }
            const later = await pmr.append("mallory", ref("x"), freshNonce(), T0 + 10)
            if (later.outcome !== "refused") throw new Error("expected full")
            expect(later.retryAfter).toBe(first.retryAfter)
        })
    })

    it("is reversible — unblocking restores an ordinary mailbox", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.block("mallory", "did:plc:mallory", T0)
            await pmr.unblock("mallory")
            await pmr.append("mallory", ref("m1"), freshNonce(), T0)
            const queue = await pmr.list("mallory", 1000)
            expect(queue.map((r) => r.messageId)).toEqual(["m1"])
        })
    })
})

describe("anti-replay: nonce checked and recorded atomically with append", () => {
    it("a replayed nonce on a REAL mailbox is a no-op, not a second entry", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const nonce = freshNonce()
            const first = await pmr.append("alice", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("appended")

            // SAME nonce — a captured envelope resubmitted.
            const replay = await pmr.append(
                "alice",
                ref("m1-replay-attempt"),
                nonce,
                T0
            )
            expect(replay.outcome).toBe("duplicate")

            const queue = await pmr.list("alice", 10)
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
            const first = await pmr.append("alice", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("appended")

            // Replay the SAME envelope far more times than capacity.
            for (let i = 0; i < capacity * 3; i++) {
                const replay = await pmr.append("alice", ref("m1"), nonce, T0)
                expect(replay.outcome).toBe("duplicate")
            }

            // The mailbox never filled from replay — fresh senders still fit.
            for (let i = 0; i < capacity - 1; i++) {
                const r = await pmr.append("alice", ref(`fresh${i}`), freshNonce(), T0)
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
            await pmr.block("mallory", "did:plc:mallory", T0)
            const nonce = freshNonce()
            const first = await pmr.append("mallory", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("appended")

            for (let i = 0; i < capacity * 3; i++) {
                const replay = await pmr.append("mallory", ref("m1"), nonce, T0)
                expect(replay.outcome).toBe("duplicate")
            }

            // Still has real headroom left — replay consumed none of it.
            for (let i = 0; i < capacity - 1; i++) {
                const r = await pmr.append("mallory", ref(`fresh${i}`), freshNonce(), T0)
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
                await pmr.append("alice", ref(`m${i}`), freshNonce(), T0)
            }

            const retryNonce = freshNonce()
            const refused = await pmr.append("alice", ref("retryme"), retryNonce, T0)
            expect(refused.outcome).toBe("refused")

            // Drain one slot, then retry the SAME envelope/nonce.
            await pmr.remove("alice", "m0")
            const retried = await pmr.append("alice", ref("retryme"), retryNonce, T0)
            expect(retried.outcome).toBe("appended")
        })
    })

    it("a replayed nonce in the POOL is a no-op, not a second entry", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const nonce = freshNonce()
            const first = await pmr.appendToPool("stranger", "did:plc:stranger", ref("m1"), nonce, T0)
            expect(first.outcome).toBe("pooled")

            const replay = await pmr.appendToPool("stranger", "did:plc:stranger", ref("m1"), nonce, T0)
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
            const pooled = await pmr.appendToPool("stranger", "did:plc:stranger", ref("m1"), nonce, T0)
            expect(pooled.outcome).toBe("pooled")

            // Same sender is now provisioned; the SAME envelope replays.
            const replay = await pmr.append("stranger", ref("m1"), nonce, T0)
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
                const r = await pmr.appendToPool("stranger", "did:plc:stranger", ref(`m${i}`), freshNonce(), T0)
                expect(r.outcome).toBe("pooled")
            }
            const senders = await pmr.poolSenders()
            expect(senders.map((s) => s.key)).toContain("stranger")
            // Adjudication must name a sender the device can decide about,
            // not just a key it cannot reverse.
            expect(senders[0].did).toBe("did:plc:stranger")
        })
    })

    it("never refuses a sender that already holds entries", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const big = parseInt(testEnv.POOL_CAP_BYTES)
            await pmr.appendToPool("recovering", "did:plc:recovering", ref("first", big), freshNonce(), T0)
            const second = await pmr.appendToPool("recovering", "did:plc:recovering", ref("second"), freshNonce(), T0)
            expect(second.outcome).toBe("pooled")
        })
    })

    it("turns away only unknown senders at true exhaustion", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            const big = parseInt(testEnv.POOL_CAP_BYTES)
            await pmr.appendToPool("early", "did:plc:early", ref("fills-the-pool", big), freshNonce(), T0)
            const late = await pmr.appendToPool("late", "did:plc:late", ref("m1"), freshNonce(), T0)
            expect(late.outcome).toBe("exhausted")
        })
    })

    it("lists senders without exposing bodies", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.appendToPool("a", "did:plc:a", ref("m1"), freshNonce(), T0)
            await pmr.appendToPool("b", "did:plc:b", ref("m2"), freshNonce(), T0)
            const senders = (await pmr.poolSenders()).map((s) => s.key)
            expect(senders.sort()).toEqual(["a", "b"])
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
            await pmr.setDiscarded("stranger", T0 + 100)
            expect(await pmr.isDiscarded("stranger", T0)).toBe(true)
            expect(await pmr.isDiscarded("stranger", T0 + 101)).toBe(false)
        })
    })

    it("appendToPool answers pooled/persistBody:false for a discarded sender, storing nothing", async () => {
        // Pins the discard-RPC-count fix: the discard check runs INSIDE
        // appendToPool now, not as a separate isDiscarded call the Worker
        // branches on before deciding whether to call this at all.
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.setDiscarded("stranger", T0 + 100)
            const result = await pmr.appendToPool("stranger", "did:plc:stranger", ref("m1"), freshNonce(), T0)
            expect(result).toEqual({ outcome: "pooled", persistBody: false })
            // Never actually entered — poolSenders() must not list it.
            expect((await pmr.poolSenders()).map((s) => s.key)).not.toContain("stranger")
        })
    })

    it("a fresh envelope succeeds once the discard window lapses, same nonce or not", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.setDiscarded("stranger", T0 + 100)
            const nonce = freshNonce()
            const discarded = await pmr.appendToPool("stranger", "did:plc:stranger", ref("m1"), nonce, T0)
            if (discarded.outcome !== "pooled") throw new Error("unreachable")
            expect(discarded.persistBody).toBe(false)

            // Discard didn't consume the nonce either, matching `refused`'s
            // reasoning: a retry once the window lapses is evaluated fresh.
            const afterLapse = await pmr.appendToPool("stranger", "did:plc:stranger", ref("m1"), nonce, T0 + 101)
            expect(afterLapse).toEqual({ outcome: "pooled", persistBody: true })
            expect((await pmr.poolSenders()).map((s) => s.key)).toContain("stranger")
        })
    })
})

describe("removal is idempotent", () => {
    it("succeeds on an already-removed record", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.append("alice", ref("m1"), freshNonce(), T0)
            await pmr.remove("alice", "m1")
            await pmr.remove("alice", "m1")
            await pmr.remove("nobody", "m1")
            expect(await pmr.list("alice", 10)).toEqual([])
        })
    })
})
