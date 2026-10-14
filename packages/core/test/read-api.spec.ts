/**
 * Two fields sharing a wire key in one body would decode as each other. The
 * types already force every field to have a key; this pins that no two share
 * one.
 */
import { describe, expect, it } from "vitest"
import {
    GRAPH_EDGE_KEYS,
    GRAPH_READ_KEYS,
    RECORD_READ_KEYS,
} from "../src/read-api"

describe("read API wire keys", () => {
    it.each([
        ["RECORD_READ_KEYS", RECORD_READ_KEYS],
        ["GRAPH_READ_KEYS", GRAPH_READ_KEYS],
        ["GRAPH_EDGE_KEYS", GRAPH_EDGE_KEYS],
    ])("%s gives every field a distinct key", (_, keys) => {
        const values = Object.values(keys)
        expect(new Set(values).size).toBe(values.length)
    })
})
