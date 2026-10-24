/**
 * Signed did:plc operations and logs for tests that need a chain they can
 * extend: the keys are throwaway test keys, so unlike a real directory log
 * the test can sign the next operation.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import type { PlcLog, PlcLogEntry } from "../../src/plc-log"
import { CID_PREFIX, base32Lower, cidToString, encodeDagCbor } from "../../src/repo-proof"
import { binaryToBase64URL } from "../../src/util"
import { makeKey, sign, type TestKey } from "./repo-car"

const didKey = (key: TestKey) => `did:key:${key.multikey}`

export const operationCid = (operation: Record<string, unknown>): string =>
    cidToString(Uint8Array.of(...CID_PREFIX, ...sha256(encodeDagCbor(operation))))

export function signedOperation(
    key: TestKey,
    unsigned: Record<string, unknown>
): Record<string, unknown> {
    return { ...unsigned, sig: binaryToBase64URL(sign(key, encodeDagCbor(unsigned))) }
}

let clock = Date.now() - 100_000

export function logEntry(operation: Record<string, unknown>): PlcLogEntry {
    clock += 1000
    return { cid: operationCid(operation), operation, createdAtMs: clock, nullified: false }
}

/**
 * A DID with a signed genesis, its rotation and signing keys, and builders
 * for what follows it.
 */
export function syntheticPlcChain() {
    const rotation = makeKey()
    const signing = makeKey()
    const body = (prev: string | null, tag: string) => ({
        type: "plc_operation",
        rotationKeys: [didKey(rotation)],
        verificationMethods: { atproto: didKey(signing) },
        alsoKnownAs: [`at://${tag}.test`],
        services: {
            atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: `https://${tag}.example` },
        },
        prev,
    })
    const genesisOp = signedOperation(rotation, body(null, "a"))
    const did = `did:plc:${base32Lower(sha256(encodeDagCbor(genesisOp))).slice(0, 24)}`
    const g = logEntry(genesisOp)
    return {
        did,
        rotation,
        signing,
        g,
        next: (prev: string, tag: string) => logEntry(signedOperation(rotation, body(prev, tag))),
        log: (entries: PlcLogEntry[], asOfMs = Date.now()): PlcLog => ({ did, entries, asOfMs }),
    }
}
