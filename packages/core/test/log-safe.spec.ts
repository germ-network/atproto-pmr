import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { boundedErrorName, errorKind } from "../src/log-safe"

const DID = "did:plc:seededlogcapture000000000"

describe("errorKind", () => {
    it("is the error's class name, never its message or stack", () => {
        const err = new TypeError(`fetch failed for ${DID}`)
        expect(errorKind(err)).toBe("TypeError")
    })

    it("holds a name that is not a plain identifier to Error", () => {
        const err = new Error("x")
        err.name = `Error for ${DID}`
        expect(errorKind(err)).toBe("Error")
        expect(boundedErrorName("A".repeat(65))).toBe("Error")
        expect(boundedErrorName("RecordNotFound")).toBe("RecordNotFound")
    })

    it("is the type of a thrown non-error, never its value", () => {
        expect(errorKind(DID)).toBe("string")
        expect(errorKind({ did: DID })).toBe("object")
        expect(errorKind(undefined)).toBe("undefined")
    })

    it("is the same in every package", () => {
        const source = (pkg: string) => readFileSync(new URL(`../../${pkg}/src/log-safe.ts`, import.meta.url), "utf8")
        for (const pkg of ["cloudflare", "monitor", "monitor-cloudflare"]) {
            expect(source(pkg)).toBe(source("core"))
        }
    })
})
