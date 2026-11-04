/**
 * Shared harness for the sender-hold specs: an in-memory `SenderHoldStorage`,
 * signed pair-put envelopes, and declarations built as signed CARs.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { decodePairPutEnvelope, encodePairPutEnvelope } from "../../src/cose/sign1"
import type { SenderDeclarationResolution } from "../../src/declaration"
import { asPairMailboxKey } from "../../src/mailbox-key"
import type {
    HeldPairPut,
    InterimDeclaration,
    SenderHoldStorage,
    SettledSenderDeclaration,
    StoredSettledDeclaration,
} from "../../src/sender-hold"
import { buildRepoCar } from "./repo-car"

export const SENDER = "did:plc:sender000000000000000000"
export const SENDER_KEY = asPairMailboxKey(SENDER)
export const RECIPIENT = "did:plc:recipient00000000000000000"
export const DECL_PATH = "com.germnetwork.declaration/self"

/** Revisions are TIDs; later letters sort later. */
export const REV = {
    old: "3kaaaaaaaaaaa",
    mid: "3kbbbbbbbbbbb",
    new: "3kccccccccccc",
    newer: "3kddddddddddd",
}

export interface Pair {
    secretKey: Uint8Array
    publicKey: Uint8Array
}

export function keyPair(): Pair {
    const secretKey = ed25519.utils.randomSecretKey()
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

let nonceCounter = 0
export function nextNonce(): Uint8Array {
    const nonce = new Uint8Array(16)
    new DataView(nonce.buffer).setUint32(0, ++nonceCounter)
    return nonce
}

export function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function envelope(
    secretKey: Uint8Array,
    options: { recipient?: string; nonce?: Uint8Array; sender?: string; body?: string } = {}
): Uint8Array {
    return encodePairPutEnvelope(
        {
            senderDID: options.sender ?? SENDER,
            recipientDID: options.recipient ?? RECIPIENT,
            kid: new Uint8Array(32).fill(0xaa),
            nonce: options.nonce ?? nextNonce(),
            payload: new TextEncoder().encode(options.body ?? "sealed"),
        },
        (message) => ed25519.sign(message, secretKey)
    )
}

export function nonceHexOf(bytes: Uint8Array): string {
    return hex(decodePairPutEnvelope(bytes).payload.nonce)
}

export function resolution(
    publicKey: Uint8Array,
    revision: string,
    declarationCID = `cid-${revision}`
): Extract<SenderDeclarationResolution, { found: true }> {
    return {
        found: true,
        anchorKey: { x: publicKey },
        declarationCID,
        revision,
        evidenceCAR: new Uint8Array([1, 2, 3]),
    }
}

export function storedSettled(
    publicKey: Uint8Array,
    revision: string,
    settledAtSeconds: number
): StoredSettledDeclaration {
    return { declaration: resolution(publicKey, revision), settledAtSeconds }
}

/** A settled declaration as the monitor hands it over: a signed CAR holding the record. */
export function settledDeclaration(
    publicKey: Uint8Array,
    revision: string,
    options: { did?: string; carRev?: string; cid?: string } = {}
): SettledSenderDeclaration {
    const repo = buildRepoCar({
        did: options.did ?? SENDER,
        rev: options.carRev ?? revision,
        records: {
            [DECL_PATH]: {
                $type: "com.germnetwork.declaration",
                version: "1.2.0",
                currentKey: Uint8Array.of(3, ...publicKey),
            },
        },
    })
    return { rev: revision, cid: options.cid ?? repo.recordCids[DECL_PATH]!, car: repo.car }
}

export interface MemoryStorage extends SenderHoldStorage {
    state: {
        settled: StoredSettledDeclaration | null
        interim: InterimDeclaration | null
        lastDirectReadAt: number | null
        held: HeldPairPut[]
    }
}

export function memoryStorage(initial: Partial<MemoryStorage["state"]> = {}): MemoryStorage {
    const state: MemoryStorage["state"] = {
        settled: null,
        interim: null,
        lastDirectReadAt: null,
        held: [],
        ...initial,
    }
    return {
        state,
        settled: async () => state.settled,
        setSettled: async (value) => void (state.settled = value),
        interim: async () => state.interim,
        setInterim: async (value) => void (state.interim = value),
        lastDirectReadAt: async () => state.lastDirectReadAt,
        setLastDirectReadAt: async (seconds) => void (state.lastDirectReadAt = seconds),
        held: async () => [...state.held],
        append: async (put) => void state.held.push(put),
        remove: async (nonceHexes) => {
            state.held = state.held.filter((put) => !nonceHexes.includes(put.nonceHex))
        },
    }
}

export function heldPut(
    secretKey: Uint8Array,
    options: {
        recipient?: string
        heldUnder?: string
        heldAt?: number
        expiresAt?: number
        nonce?: Uint8Array
        body?: string
    } = {}
): HeldPairPut {
    const nonce = options.nonce ?? nextNonce()
    const heldAt = options.heldAt ?? 1_000
    return {
        recipientDID: options.recipient ?? RECIPIENT,
        envelope: envelope(secretKey, { recipient: options.recipient, nonce, body: options.body }),
        nonceHex: hex(nonce),
        heldUnderRevision: options.heldUnder ?? REV.new,
        heldAtSeconds: heldAt,
        expiresAtSeconds: options.expiresAt ?? heldAt + 600,
    }
}
