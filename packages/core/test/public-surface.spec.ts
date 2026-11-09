/** No public read serves a follow graph: the core package exports no graph read route or wire type. */
import { describe, expect, it } from "vitest"
import * as core from "../src"

describe("core public surface", () => {
    // Runtime values only: type-only removals are proven by src no longer declaring them.
    it("exports no handleGraphRead, projectGraph or graph read codec value", () => {
        for (const name of [
            "handleGraphRead",
            "projectGraph",
            "encodeGraphReadResponse",
            "decodeGraphReadResponse",
            "graphToCose",
            "graphFromCose",
        ]) {
            expect(core).not.toHaveProperty(name)
        }
    })

    it("exports no GRAPH_READ_KEYS or GRAPH_EDGE_KEYS", () => {
        expect(core).not.toHaveProperty("GRAPH_READ_KEYS")
        expect(core).not.toHaveProperty("GRAPH_EDGE_KEYS")
    })
})

describe("request mailboxes replaced the recovery pool", () => {
    it("exports no pool listing, adjudication, frame or push payload builder", () => {
        for (const name of ["handlePoolList", "handlePoolAdjudication", "encodePoolFrame", "buildPoolPushPayload"]) {
            expect(core).not.toHaveProperty(name)
        }
    })

    it("exports the request listing", () => {
        expect(core).toHaveProperty("handleRequestsList")
        expect(core).toHaveProperty("requestListingFields")
    })
})

describe("fetch-one surface", () => {
    it("exports handleMessageRead, parseMessageReadPath, messageMissResponse, readMessageEntry and messageEntryFields", () => {
        for (const name of [
            "handleMessageRead",
            "parseMessageReadPath",
            "messageMissResponse",
            "readMessageEntry",
            "messageEntryFields",
        ]) {
            expect(core, name).toHaveProperty(name)
        }
    })
})
