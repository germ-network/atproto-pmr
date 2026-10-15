/**
 * A did:plc operation log the PMR serves verifies the way a device verifies
 * it, and a stream operation that does not chain is never appended.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import { describe, expect, it } from "vitest"
import {
    appendPlcLogEntry,
    parsePlcAuditLog,
    PlcLogError,
    verifyPlcLog,
    type PlcLog,
    type PlcLogEntry,
} from "../src/plc-log"
import { CID_PREFIX, base32Lower, cidToString, encodeDagCbor } from "../src/repo-proof"
import { binaryToBase64URL } from "../src/util"
import legacyFixture from "./fixtures/plc-log-legacy-genesis.json"
import modernFixture from "./fixtures/plc-log-modern.json"
import { highS, makeKey, sign, type TestKey } from "./fixtures/repo-car"

type Fixture = { did: string; audit: unknown; document: unknown }
const fixtures: Fixture[] = [legacyFixture, modernFixture]

const entriesOf = (f: Fixture): PlcLogEntry[] => parsePlcAuditLog(f.did, f.audit)!

// ---- synthetic logs --------------------------------------------------------

const didKey = (key: TestKey) => `did:key:${key.multikey}`
const cidOf = (op: Record<string, unknown>) =>
    cidToString(Uint8Array.of(...CID_PREFIX, ...sha256(encodeDagCbor(op))))

function signed(
    key: TestKey,
    unsigned: Record<string, unknown>,
    options: { highS?: boolean } = {}
): Record<string, unknown> {
    const message = encodeDagCbor(unsigned)
    let sig = sign(key, message)
    if (options.highS) sig = highS(key, sig)
    return { ...unsigned, sig: binaryToBase64URL(sig) }
}

const body = (rotationKeys: TestKey[], signingKey: TestKey, prev: string | null, tag = "a") => ({
    type: "plc_operation",
    rotationKeys: rotationKeys.map(didKey),
    verificationMethods: { atproto: didKey(signingKey) },
    alsoKnownAs: [`at://${tag}.test`],
    services: {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: `https://${tag}.example` },
    },
    prev,
})

/** The CID with its last character changed, whatever it was. */
const otherCid = (cid: string) => cid.slice(0, -1) + (cid.endsWith("a") ? "b" : "a")

let clock = Date.parse("2026-01-01T00:00:00.000Z")
function entry(operation: Record<string, unknown>, nullified = false): PlcLogEntry {
    clock += 1000
    return { cid: cidOf(operation), operation, createdAtMs: clock, nullified }
}
const didOf = (genesis: Record<string, unknown>) =>
    `did:plc:${base32Lower(sha256(encodeDagCbor(genesis))).slice(0, 24)}`

function chain() {
    const rotation = makeKey()
    const recovery = makeKey()
    const signing = makeKey()
    const genesisOp = signed(rotation, body([recovery, rotation], signing, null))
    const g = entry(genesisOp)
    const did = didOf(genesisOp)
    const second = entry(signed(rotation, body([recovery, rotation], signing, g.cid, "b")))
    return { rotation, recovery, signing, did, g, second }
}

describe("parsePlcAuditLog", () => {
    it("parses a directory audit log body, oldest first, nullified entries kept", () => {
        const f = modernFixture
        const parsed = parsePlcAuditLog(f.did, f.audit)!
        expect(parsed).toHaveLength(f.audit.length)
        expect(parsed.map((e) => e.cid)).toEqual(f.audit.map((e) => e.cid))
        expect(parsed[0]).toMatchObject({
            createdAtMs: Date.parse(f.audit[0]!.createdAt),
            nullified: false,
        })
        const withNullified = f.audit.map((e, i) => (i === 1 ? { ...e, nullified: true } : e))
        expect(parsePlcAuditLog(f.did, withNullified)![1]!.nullified).toBe(true)
        expect(parsed[1]!.createdAtMs).toBeGreaterThanOrEqual(parsed[0]!.createdAtMs)
    })

    it("is null for a body for another DID, or not an audit log", () => {
        expect(parsePlcAuditLog("did:plc:other", modernFixture.audit)).toBeNull()
        expect(parsePlcAuditLog(modernFixture.did, { message: "not found" })).toBeNull()
        expect(parsePlcAuditLog(modernFixture.did, [])).toBeNull()
        expect(parsePlcAuditLog(modernFixture.did, [{ did: modernFixture.did }])).toBeNull()
        const badTime = modernFixture.audit.map((e) => ({ ...e, createdAt: "never" }))
        expect(parsePlcAuditLog(modernFixture.did, badTime)).toBeNull()
    })
})

describe("verifyPlcLog", () => {
    it.each(fixtures.map((f) => [f.did, f] as const))(
        "a real directory audit log fixture verifies to the document the directory renders (%s)",
        (_did, f) => {
            expect(verifyPlcLog(f.did, entriesOf(f))).toEqual(f.document)
        }
    )

    it("a log whose genesis is a legacy create verifies, hashed in its own format", () => {
        const entries = entriesOf(legacyFixture)
        expect(entries[0]!.operation.type).toBe("create")
        expect(verifyPlcLog(legacyFixture.did, entries)).not.toBeNull()
        // Re-encoding the legacy genesis as the regular format would not name the DID.
        const g = entries[0]!.operation
        const regular = {
            type: "plc_operation",
            rotationKeys: [g.recoveryKey, g.signingKey],
            verificationMethods: { atproto: g.signingKey },
            alsoKnownAs: [`at://${g.handle}`],
            services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: g.service } },
            prev: null,
            sig: g.sig,
        }
        expect(didOf(regular)).not.toBe(legacyFixture.did)
        expect(didOf(g as Record<string, unknown>)).toBe(legacyFixture.did)
    })

    it("a legacy-only log renders the normalised document", () => {
        const entries = entriesOf(legacyFixture).slice(0, 1)
        const g = entries[0]!.operation
        const doc = verifyPlcLog(legacyFixture.did, entries)!
        expect(doc).toMatchObject({
            id: legacyFixture.did,
            alsoKnownAs: [`at://${g.handle}`],
            verificationMethod: [
                {
                    id: `${legacyFixture.did}#atproto`,
                    type: "Multikey",
                    controller: legacyFixture.did,
                    publicKeyMultibase: (g.signingKey as string).slice("did:key:".length),
                },
            ],
            service: [
                { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: g.service },
            ],
        })
    })

    it("the operation after a legacy genesis is signed by recoveryKey or signingKey", () => {
        const recovery = makeKey()
        const signing = makeKey()
        const legacy = signed(recovery, {
            type: "create",
            signingKey: didKey(signing),
            recoveryKey: didKey(recovery),
            handle: "old.test",
            service: "https://old.example",
            prev: null,
        })
        const g = entry(legacy)
        const did = didOf(legacy)
        const next = (key: TestKey) =>
            entry(signed(key, body([recovery, signing], signing, g.cid, "new")))
        expect(verifyPlcLog(did, [g, next(recovery)])).not.toBeNull()
        expect(verifyPlcLog(did, [g, next(signing)])).not.toBeNull()
        expect(() => verifyPlcLog(did, [g, next(makeKey())])).toThrow(/rotation key/)
        // A second `create` is not a valid operation after the genesis.
        const second = entry(
            signed(recovery, {
                type: "create",
                signingKey: didKey(signing),
                recoveryKey: didKey(recovery),
                handle: "old.test",
                service: "https://old.example",
                prev: g.cid,
            })
        )
        expect(() => verifyPlcLog(did, [g, second])).toThrow(/legacy create/)
        // The real log's first update was signed by one of the genesis keys.
        expect(verifyPlcLog(legacyFixture.did, entriesOf(legacyFixture).slice(0, 2))).not.toBeNull()
    })

    it("a genesis CID that does not name the DID throws", () => {
        const { g, did } = chain()
        expect(() => verifyPlcLog(did, [g])).not.toThrow()
        expect(() => verifyPlcLog("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", [g])).toThrow(/name the DID/)
    })

    it("an operation signed by a key that is not a prior rotation key throws", () => {
        const { g, did, signing, recovery, rotation } = chain()
        const stranger = makeKey()
        const bad = entry(signed(stranger, body([recovery, rotation], signing, g.cid, "x")))
        expect(() => verifyPlcLog(did, [g, bad])).toThrow(/rotation key/)
        // The signing key has no control unless it is a rotation key.
        const bySigning = entry(signed(signing, body([recovery, rotation], signing, g.cid, "x")))
        expect(() => verifyPlcLog(did, [g, bySigning])).toThrow(/rotation key/)
        // A key the new operation itself adds cannot sign it.
        const adds = entry(signed(stranger, body([stranger], signing, g.cid, "x")))
        expect(() => verifyPlcLog(did, [g, adds])).toThrow(/rotation key/)
    })

    it("signature encoding is strict: high-S and non-canonical base64url are rejected", () => {
        const { g, did, signing, recovery, rotation } = chain()
        const high = entry(signed(rotation, body([recovery, rotation], signing, g.cid, "x"), { highS: true }))
        expect(() => verifyPlcLog(did, [g, high])).toThrow(/rotation key/)
        const ok = signed(rotation, body([recovery, rotation], signing, g.cid, "x"))
        const sig = ok.sig as string
        // Padding, and trailing bits set in the last character, are non-canonical.
        const flipped = sig.slice(0, -1) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(sig.at(-1)!) ^ 1]
        for (const variant of [`${sig}==`, `${sig}=`, flipped]) {
            expect(() => verifyPlcLog(did, [g, entry({ ...ok, sig: variant })])).toThrow(/canonical|base64url|rotation key/)
        }
        expect(verifyPlcLog(did, [g, entry(ok)])).not.toBeNull()
    })

    it("an operation whose prev is not the prior operation's CID throws", () => {
        const { g, did, signing, recovery, rotation } = chain()
        const bad = entry(signed(rotation, body([recovery, rotation], signing, "bafyreiwrong", "x")))
        expect(() => verifyPlcLog(did, [g, bad])).toThrow(/prev/)
    })

    it("a duplicate CID throws", () => {
        const { g, did, second } = chain()
        expect(() => verifyPlcLog(did, [g, second, second])).toThrow(/duplicate/)
    })

    it("a nullified operation must still be signed by a rotation key of its prev", () => {
        const { g, did, signing, recovery, rotation } = chain()
        const forged = entry(signed(makeKey(), body([recovery, rotation], signing, g.cid, "f")), true)
        const forkAtGenesis = entry(signed(recovery, body([recovery], signing, g.cid, "e")))
        expect(() => verifyPlcLog(did, [g, forged, forkAtGenesis])).toThrow(/rotation key/)
    })

    it("a P-256 rotation key signs a chain", () => {
        const rotation = makeKey("p256")
        const signing = makeKey()
        const genesisOp = signed(rotation, body([rotation], signing, null))
        const g = entry(genesisOp)
        const next = entry(signed(rotation, body([rotation], signing, g.cid, "p")))
        expect(verifyPlcLog(didOf(genesisOp), [g, next])!.alsoKnownAs).toEqual(["at://p.test"])
    })

    it("a tombstone that was nullified by a recovery fork leaves the recovered chain", () => {
        const { g, did, signing, recovery, rotation } = chain()
        const tomb = entry(signed(rotation, { type: "plc_tombstone", prev: g.cid }), true)
        const recovered = entry(signed(recovery, body([recovery], signing, g.cid, "r")))
        expect(verifyPlcLog(did, [g, tomb, recovered])!.alsoKnownAs).toEqual(["at://r.test"])
    })

    it("a verified log whose last operation cannot be rendered is unrenderable, not broken", () => {
        const rotation = makeKey()
        const op = signed(rotation, {
            ...body([rotation], makeKey(), null),
            alsoKnownAs: [],
        })
        try {
            verifyPlcLog(didOf(op), [entry(op)])
            throw new Error("expected a throw")
        } catch (error) {
            expect(error).toBeInstanceOf(PlcLogError)
            expect((error as PlcLogError).kind).toBe("unrenderable")
        }
        const { g, did } = chain()
        expect(() => verifyPlcLog(did, [{ ...g, cid: otherCid(g.cid) }])).toThrow(PlcLogError)
    })

    it("a CID that is not the operation's own throws", () => {
        const { g, did, second } = chain()
        expect(() => verifyPlcLog(did, [g, { ...second, cid: otherCid(g.cid) }])).toThrow(
            /cid/
        )
        expect(() => verifyPlcLog(did, [{ ...g, cid: second.cid }])).toThrow(/cid/)
    })

    it("nullified operations are skipped in the chain", () => {
        const { g, did, signing, recovery, rotation } = chain()
        const rogue = entry(signed(rotation, body([recovery, rotation], signing, g.cid, "rogue")), true)
        const recoveryOp = entry(signed(recovery, body([recovery], signing, g.cid, "recovered")))
        const doc = verifyPlcLog(did, [g, rogue, recoveryOp])!
        expect(doc.alsoKnownAs).toEqual(["at://recovered.test"])
    })

    it("a nullified operation with no later live operation forking at or before it throws", () => {
        const { g, did, second } = chain()
        const nullified = { ...second, nullified: true }
        expect(() => verifyPlcLog(did, [g, nullified])).toThrow(/nullified/)
    })

    it("a nullified branch is superseded only by an operation forking at or before it", () => {
        const { g, did, signing, recovery, rotation, second } = chain()
        // g -> second (live) -> third; a nullified branch off g that a later operation off second does not supersede.
        const third = entry(signed(rotation, body([recovery, rotation], signing, second.cid, "c")))
        const sideBranch = entry(signed(rotation, body([recovery, rotation], signing, g.cid, "d")), true)
        expect(() => verifyPlcLog(did, [g, second, sideBranch, third])).toThrow(/nullified/)
        // Forking at the same point, or earlier, supersedes it.
        const forkedThird = entry(signed(rotation, body([recovery, rotation], signing, g.cid, "c")))
        expect(
            verifyPlcLog(did, [g, { ...second, nullified: true }, forkedThird])!.alsoKnownAs
        ).toEqual(["at://c.test"])
        // A nullified operation after the fork that replaced it is superseded too.
        const abandoned = entry(signed(rotation, body([recovery, rotation], signing, second.cid, "z")), true)
        expect(
            verifyPlcLog(did, [g, { ...second, nullified: true }, abandoned, forkedThird])!.alsoKnownAs
        ).toEqual(["at://c.test"])
    })

    it("a tombstoned log verifies to null", () => {
        const { g, did, rotation } = chain()
        const tomb = entry(signed(rotation, { type: "plc_tombstone", prev: g.cid }))
        expect(verifyPlcLog(did, [g, tomb])).toBeNull()
        const after = entry(signed(rotation, body([rotation], makeKey(), tomb.cid, "z")))
        expect(() => verifyPlcLog(did, [g, tomb, after])).toThrow(/tombstone/)
    })
})

describe("appendPlcLogEntry", () => {
    const logOf = (entries: PlcLogEntry[], asOfMs = 0, did = "did:plc:x"): PlcLog => ({
        did,
        entries,
        asOfMs,
    })

    it("an operation whose prev is the last live CID is appended and moves asOfMs", () => {
        const { g, second } = chain()
        const out = appendPlcLogEntry(logOf([g], g.createdAtMs), second)!
        expect(out.entries).toEqual([g, second])
        expect(out.asOfMs).toBe(second.createdAtMs)
    })

    it("an operation that does not chain returns null", () => {
        const { g, signing, recovery, rotation } = chain()
        const stray = entry(signed(rotation, body([recovery, rotation], signing, "bafyreinowhere", "x")))
        expect(appendPlcLogEntry(logOf([g]), stray)).toBeNull()
    })

    it("a recovery operation forking before the tail returns null", () => {
        const { g, second, signing, recovery } = chain()
        const fork = entry(signed(recovery, body([recovery], signing, g.cid, "r")))
        expect(appendPlcLogEntry(logOf([g, second]), fork)).toBeNull()
    })

    it("an operation not signed by a rotation key of the last entry returns null", () => {
        const { g, signing, recovery, rotation } = chain()
        const forged = entry(signed(makeKey(), body([recovery, rotation], signing, g.cid, "x")))
        expect(appendPlcLogEntry(logOf([g]), forged)).toBeNull()
        const legacyAfter = entry(signed(rotation, { ...body([rotation], signing, g.cid), type: "create" }))
        expect(appendPlcLogEntry(logOf([g]), legacyAfter)).toBeNull()
        expect(appendPlcLogEntry(logOf([g]), { ...entry(signed(rotation, body([rotation], signing, g.cid))), nullified: true })).toBeNull()
    })

    it("an entry whose cid is not its operation's own returns null", () => {
        const { g, second } = chain()
        expect(appendPlcLogEntry(logOf([g]), { ...second, cid: g.cid })).toBeNull()
    })

    it("chains onto the last live entry, skipping nullified ones, and not after a tombstone", () => {
        const { g, second, rotation } = chain()
        const nullifiedTail = { ...second, nullified: true }
        const next = entry(signed(rotation, body([rotation], makeKey(), g.cid, "n")))
        expect(appendPlcLogEntry(logOf([g, nullifiedTail]), next)).not.toBeNull()
        const tomb = entry(signed(rotation, { type: "plc_tombstone", prev: g.cid }))
        const after = entry(signed(rotation, body([rotation], makeKey(), tomb.cid, "n")))
        expect(appendPlcLogEntry(logOf([g, tomb]), after)).toBeNull()
    })
})
