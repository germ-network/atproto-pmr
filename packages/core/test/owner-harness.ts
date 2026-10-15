/** A signed owner request against an in-memory directory and a stub store. */
import { ed25519 } from "@noble/curves/ed25519.js"
import { encodeBinding } from "../src/challenge"
import { decodeCoseMap } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import { signRequest } from "../src/http-sig/sign"
import type { OwnerDeps } from "../src/owner/endpoints"
import type { ChallengeStore, Locator, PMRStore, RegistrationFields } from "../src/storage"

export const T0 = 1_760_000_000
export const ORIGIN = "https://relay.example"
export const OWNER = "did:plc:owner0000000000000000000"

export async function ownerWorld(stub: Partial<PMRStore>, overrides: Partial<OwnerDeps> = {}) {
    const rows = new Map<string, string>()
    const challenges: ChallengeStore = {
        async mint(c, boundTo) {
            rows.set(c, boundTo)
        },
        async consume(c) {
            const v = rows.get(c)
            rows.delete(c)
            return v ?? null
        },
    }
    const secretKey = ed25519.utils.randomSecretKey()
    const registration: RegistrationFields = {
        did: OWNER,
        anchorKey: encodeOkpEd25519Key({ x: ed25519.getPublicKey(secretKey) }),
        lastActive: T0,
    }
    const directory = {
        resolve: async (did: string): Promise<Locator | null> => (did === OWNER ? "loc" : null),
    } as never
    const store = { load: async () => registration, ...stub } as unknown as PMRStore
    const deps: OwnerDeps = {
        challenges,
        directory,
        resolveLocator: async (did) => (did === OWNER ? "loc" : null),
        store: () => store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        ...overrides,
    } as OwnerDeps

    let n = 0
    async function request(path: string, method = "GET"): Promise<Request> {
        n += 1
        const nonce = `chal-${n}`
        await challenges.mint(nonce, encodeBinding({ realm: "anchor", subject: OWNER }), T0 + 600)
        const url = `${ORIGIN}${path}`
        const parts = signRequest({ method, url, nonce, keyid: "t", secretKey })
        return new Request(url, { method, headers: parts.headers })
    }
    return { deps, request }
}

export async function cborMap(response: Response) {
    return decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
}
