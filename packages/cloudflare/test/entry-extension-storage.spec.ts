import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, MessageRef } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = 1_760_000_000
const B = "did:plc:bob"
const NO: Admission = { verdict: "no", why: ["not-admitted"] }
const YES: Admission = { verdict: "yes" }

const ref = (id: string): MessageRef => ({
    messageId: id,
    byteLength: 100,
    hint: {
        senderDID: B,
        declarationCID: "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e",
    },
    ext: { flag: true, tag: "x", n: 7, nil: null, bytes: new Uint8Array([1, 2]) },
})

let counter = 0
const freshStub = (): DurableObjectStub<PMRObject> => {
    counter += 1
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`ext-${counter}`))
}
const nonce = (n: number) => new Uint8Array(16).fill(n)

describe("entry extension fields in storage", () => {
    it("ext on a pooled ref survives admission into the mailbox", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.receive(B, ref("p1"), nonce(1), T0, NO)
            const result = await pmr.receive(B, { ...ref("m1"), ext: undefined }, nonce(2), T0, YES)
            expect(result).toEqual(
                expect.objectContaining({ outcome: "queued", moved: [ref("p1")] })
            )
            const listed = await pmr.list(B, 10)
            expect(listed.find((r) => r.messageId === "p1")).toEqual(ref("p1"))
        })
    })

    it("ext on a pooled ref survives provisioning from the pool", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.receive(B, ref("p1"), nonce(1), T0, NO)
            await pmr.provisionFromPool(B, T0)
            expect(await pmr.list(B, 10)).toEqual([ref("p1")])
        })
    })
})
