/**
 * A failed or slow admission read never fails or stalls a put: it becomes an
 * unknown verdict the device can judge from the pool.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    ADMISSION_UNAVAILABLE,
    admissionOrUnavailable,
    type Admission,
    type AdmissionSource,
} from "../src/admission"

const SENDER = "did:plc:sender000000000000000000"
const RECIPIENT = "did:plc:recipient00000000000000000"
const UNAVAILABLE = { verdict: "unknown", why: [ADMISSION_UNAVAILABLE] }

afterEach(() => vi.useRealTimers())

describe("admissionOrUnavailable", () => {
    it("returns the source's verdict unchanged when the read succeeds in time", async () => {
        const seen: Array<[string, string]> = []
        const verdict: Admission = { verdict: "no", why: ["not-admitted"] }
        const source: AdmissionSource = {
            admission: async (s, r) => {
                seen.push([s, r])
                return verdict
            },
        }
        expect(await admissionOrUnavailable(source, SENDER, RECIPIENT)).toBe(verdict)
        expect(seen).toEqual([[SENDER, RECIPIENT]])
    })

    it("returns unknown with admission-unavailable when the source throws", async () => {
        const rejects: AdmissionSource = { admission: async () => Promise.reject(new Error("d1")) }
        const throws: AdmissionSource = {
            admission: () => {
                throw new Error("sync")
            },
        }
        expect(await admissionOrUnavailable(rejects, SENDER, RECIPIENT)).toEqual(UNAVAILABLE)
        expect(await admissionOrUnavailable(throws, SENDER, RECIPIENT)).toEqual(UNAVAILABLE)
    })

    it("returns unknown with admission-unavailable when the source misses the deadline", async () => {
        vi.useFakeTimers()
        const never: AdmissionSource = { admission: () => new Promise(() => {}) }
        const result = admissionOrUnavailable(never, SENDER, RECIPIENT, 50)
        await vi.advanceTimersByTimeAsync(49)
        let settled = false
        void result.then(() => (settled = true))
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await result).toEqual(UNAVAILABLE)
    })

    it("clears its deadline timer once the read settles", async () => {
        vi.useFakeTimers()
        const source: AdmissionSource = { admission: async () => ({ verdict: "yes" }) }
        await admissionOrUnavailable(source, SENDER, RECIPIENT)
        expect(vi.getTimerCount()).toBe(0)
        const failing: AdmissionSource = { admission: async () => Promise.reject(new Error("x")) }
        await admissionOrUnavailable(failing, SENDER, RECIPIENT)
        expect(vi.getTimerCount()).toBe(0)
    })
})
