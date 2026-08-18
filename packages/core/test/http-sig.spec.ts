/**
 * RFC 9421 verification.
 *
 * The signature base is pinned against a hand-written expected string
 * rather than against whatever `buildSignatureBase` happens to produce —
 * the base is the interop surface, and a test that compares the
 * implementation to itself would pass while two implementations disagreed.
 *
 * Everything else here is a refusal: the profile is mostly a list of things
 * a verifier must NOT accept, and each one is a way a signature could look
 * valid while authenticating less than it appears to.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { describe, expect, it } from "vitest"
import { signRequest } from "../src/http-sig/sign"
import {
    buildSignatureBase,
    contentDigestMatches,
    verifyRequestSignature,
} from "../src/http-sig/verify"
import {
    parseSignature,
    parseSignatureInput,
} from "../src/http-sig/structured-fields"

const T0 = 1_760_000_000
const URL_ = "https://relay.example/pmr/v1/grants"

function keypair() {
    const secretKey = ed25519.utils.randomSecretKey()
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

function requestFrom(
    headers: Record<string, string>,
    body?: Uint8Array,
    url = URL_,
    method = "POST"
): Request {
    return new Request(url, {
        method,
        headers,
        ...(body !== undefined && body.byteLength > 0 ? { body } : {}),
    })
}

function verify(
    headers: Record<string, string>,
    publicKey: Uint8Array,
    body: Uint8Array | null = null,
    url = URL_,
    method = "POST"
) {
    return verifyRequestSignature({
        request: requestFrom(headers, body ?? undefined, url, method),
        body,
        publicKey,
        nowSeconds: T0,
    })
}

describe("the signature base is exactly what RFC 9421 specifies", () => {
    it("matches a hand-written base, line for line", () => {
        const signatureInput =
            'pmr=("@method" "@authority" "@path");nonce="abc";created=1754960000;keyid="kid";alg="ed25519"'
        const request = requestFrom({ "signature-input": signatureInput })
        const entry = parseSignatureInput(signatureInput).get("pmr")!

        // Derived from the RFC by hand: one line per component, then
        // @signature-params last, no trailing newline.
        const expected = [
            '"@method": POST',
            '"@authority": relay.example',
            '"@path": /pmr/v1/grants',
            `"@signature-params": ${entry.raw}`,
        ].join("\n")

        expect(buildSignatureBase(request, entry)).toBe(expected)
    })

    it("takes @signature-params verbatim from the received header", () => {
        // Re-serializing our parse could differ from the signer byte for
        // byte and fail for a reason that looks like a key problem.
        const odd =
            'pmr=("@method" "@authority" "@path");nonce="a";keyid="k";alg="ed25519"'
        const entry = parseSignatureInput(odd).get("pmr")!
        expect(entry.raw).toBe(
            '("@method" "@authority" "@path");nonce="a";keyid="k";alg="ed25519"'
        )
        const base = buildSignatureBase(
            requestFrom({ "signature-input": odd }),
            entry
        )
        expect(base.endsWith(`"@signature-params": ${entry.raw}`)).toBe(true)
    })

    it("lowercases the authority and omits a default port", () => {
        const si = 'pmr=("@authority");nonce="a";keyid="k";alg="ed25519"'
        const entry = parseSignatureInput(si).get("pmr")!
        const base = buildSignatureBase(
            requestFrom({ "signature-input": si }, undefined, "https://ReLaY.Example:443/x"),
            entry
        )
        expect(base.split("\n")[0]).toBe('"@authority": relay.example')
    })
})

describe("a well-formed signature verifies", () => {
    it("accepts a bodyless request", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "challenge-1",
            keyid: "thumb",
            secretKey,
            created: T0,
        })
        const outcome = verify(signed.headers, publicKey)
        expect(outcome.valid).toBe(true)
        if (!outcome.valid) throw new Error("unreachable")
        expect(outcome.nonce).toBe("challenge-1")
        expect(outcome.keyid).toBe("thumb")
        expect(outcome.created).toBe(T0)
    })

    it("accepts a bodied request and checks the digest", () => {
        const { secretKey, publicKey } = keypair()
        const body = new TextEncoder().encode('{"hello":"world"}')
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "challenge-2",
            keyid: "thumb",
            secretKey,
            body,
        })
        expect(verify(signed.headers, publicKey, body).valid).toBe(true)
    })

    it("accepts a request with a query string — signRequest covers @query by default", () => {
        const { secretKey, publicKey } = keypair()
        const url = `${URL_}?cursor=abc`
        const signed = signRequest({
            method: "GET",
            url,
            nonce: "challenge-3",
            keyid: "thumb",
            secretKey,
        })
        expect(verify(signed.headers, publicKey, null, url, "GET").valid).toBe(true)
    })
})

describe("the profile's refusals", () => {
    it("rejects a signature from a different key", () => {
        const { secretKey } = keypair()
        const other = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        expect(verify(signed.headers, other.publicKey).valid).toBe(false)
    })

    it("rejects a bodied request that does not cover content-digest", () => {
        // Without it the signature authenticates WHICH request was made but
        // not WHAT it carried — an attacker could swap the body wholesale.
        const { secretKey, publicKey } = keypair()
        const body = new TextEncoder().encode("original")
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
            body,
            components: ["@method", "@authority", "@path"],
        })
        const outcome = verify(signed.headers, publicKey, body)
        expect(outcome.valid).toBe(false)
        if (outcome.valid) throw new Error("unreachable")
        expect(outcome.reason).toContain("content-digest")
    })

    it("rejects a swapped body even when the signature itself is valid", () => {
        // The signature covers the digest header, so it still verifies —
        // the digest comparison is what catches this.
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
            body: new TextEncoder().encode("original"),
        })
        const swapped = new TextEncoder().encode("tampered")
        const outcome = verify(signed.headers, publicKey, swapped)
        expect(outcome.valid).toBe(false)
        if (outcome.valid) throw new Error("unreachable")
        expect(outcome.reason).toContain("content-digest")
    })

    for (const missing of ["@method", "@authority", "@path"]) {
        it(`rejects a request that does not cover ${missing}`, () => {
            const { secretKey, publicKey } = keypair()
            const components = ["@method", "@authority", "@path"].filter(
                (c) => c !== missing
            )
            const signed = signRequest({
                method: "POST",
                url: URL_,
                nonce: "n",
                keyid: "thumb",
                secretKey,
                components,
            })
            const outcome = verify(signed.headers, publicKey)
            expect(outcome.valid).toBe(false)
            if (outcome.valid) throw new Error("unreachable")
            expect(outcome.reason).toContain(missing)
        })
    }

    it("rejects a method swap — @method is covered", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        expect(verify(signed.headers, publicKey, null, URL_, "DELETE").valid).toBe(
            false
        )
    })

    it("rejects a path swap — @path is covered", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        const replayed = verify(
            signed.headers,
            publicKey,
            null,
            "https://relay.example/pmr/v1/registrations"
        )
        expect(replayed.valid).toBe(false)
    })

    it("rejects a host swap — @authority is covered, so a captured request does not replay elsewhere", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        const elsewhere = verify(
            signed.headers,
            publicKey,
            null,
            "https://other-relay.example/pmr/v1/grants"
        )
        expect(elsewhere.valid).toBe(false)
    })

    it("rejects a request with a query string that does not cover @query", () => {
        // Without this, a signature authenticates the endpoint but not
        // which query was asked for — a captured signature could be
        // replayed against any query the base URL accepts.
        const { secretKey, publicKey } = keypair()
        const url = `${URL_}?cursor=abc`
        const signed = signRequest({
            method: "GET",
            url,
            nonce: "n",
            keyid: "thumb",
            secretKey,
            components: ["@method", "@authority", "@path"],
        })
        const outcome = verify(signed.headers, publicKey, null, url, "GET")
        expect(outcome.valid).toBe(false)
        if (outcome.valid) throw new Error("unreachable")
        expect(outcome.reason).toContain("@query")
    })

    it("rejects a query swap — @query is covered, so a captured request cannot be pointed at a different cursor", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "GET",
            url: `${URL_}?cursor=abc`,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        const swapped = verify(
            signed.headers,
            publicKey,
            null,
            `${URL_}?cursor=zzz`,
            "GET"
        )
        expect(swapped.valid).toBe(false)
    })

    it("does not require @query on a request with no query string", () => {
        // The gate is on the request, not the route: a bare GET still
        // verifies with the same three required components as before.
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "GET",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        expect(verify(signed.headers, publicKey, null, URL_, "GET").valid).toBe(true)
    })

    it("never trusts alg from the message", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        // Claiming a different algorithm is refused outright rather than
        // dispatched on — the verifier pins to what the resolved key implies.
        const tampered = {
            ...signed.headers,
            "signature-input": signed.headers["signature-input"].replace(
                'alg="ed25519"',
                'alg="rsa-pss-sha512"'
            ),
        }
        const outcome = verify(tampered, publicKey)
        expect(outcome.valid).toBe(false)
        if (outcome.valid) throw new Error("unreachable")
        expect(outcome.reason).toBe("unexpected alg")
    })

    it("rejects a missing nonce", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        const stripped = {
            ...signed.headers,
            "signature-input": signed.headers["signature-input"].replace(
                'nonce="n";',
                ""
            ),
        }
        expect(verify(stripped, publicKey).valid).toBe(false)
    })

    it("rejects missing signature headers", () => {
        const { publicKey } = keypair()
        expect(verify({}, publicKey).valid).toBe(false)
    })

    it("rejects a signature labelled for something else", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
            label: "other",
        })
        const outcome = verify(signed.headers, publicKey)
        expect(outcome.valid).toBe(false)
        if (outcome.valid) throw new Error("unreachable")
        expect(outcome.reason).toContain("pmr")
    })

    it("honours an explicit expires in the past", () => {
        const { secretKey, publicKey } = keypair()
        const signed = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n",
            keyid: "thumb",
            secretKey,
        })
        const expired = {
            ...signed.headers,
            "signature-input": signed.headers["signature-input"].replace(
                ';keyid=',
                `;expires=${T0 - 1};keyid=`
            ),
        }
        const outcome = verify(expired, publicKey)
        expect(outcome.valid).toBe(false)
        if (outcome.valid) throw new Error("unreachable")
        expect(outcome.reason).toBe("signature expired")
    })
})

describe("content-digest", () => {
    const body = new TextEncoder().encode("payload")
    const good = `sha-256=:${btoa(String.fromCharCode(...sha256(body)))}:`

    it("matches a correct digest", () => {
        expect(contentDigestMatches(good, body)).toBe(true)
    })

    it("rejects a wrong digest", () => {
        expect(contentDigestMatches(good, new TextEncoder().encode("other"))).toBe(
            false
        )
    })

    it("rejects a header offering ONLY an algorithm we do not check", () => {
        // Otherwise a sender could offer sha-512 alone, have nothing
        // verified, and swap the body freely.
        expect(contentDigestMatches("sha-512=:AAAA:", body)).toBe(false)
    })

    it("still checks sha-256 when other algorithms accompany it", () => {
        expect(contentDigestMatches(`sha-512=:AAAA:, ${good}`, body)).toBe(true)
        expect(
            contentDigestMatches(`sha-512=:AAAA:, sha-256=:AAAA:`, body)
        ).toBe(false)
    })
})

describe("the structured-fields parser refuses what it does not need", () => {
    it("rejects duplicate dictionary keys", () => {
        expect(() =>
            parseSignatureInput('pmr=("@method"), pmr=("@path")')
        ).toThrow()
    })

    it("rejects duplicate parameters", () => {
        expect(() =>
            parseSignatureInput('pmr=("@method");nonce="a";nonce="b"')
        ).toThrow()
    })

    it("rejects an unterminated inner list", () => {
        expect(() => parseSignatureInput('pmr=("@method"')).toThrow()
    })

    it("rejects a bad string escape", () => {
        expect(() => parseSignatureInput('pmr=("@met\\nhod")')).toThrow()
    })

    it("parses a byte sequence dictionary", () => {
        const parsed = parseSignature("pmr=:AAEC:")
        expect([...parsed.get("pmr")!]).toEqual([0, 1, 2])
    })

    it("rejects a non-base64 byte sequence", () => {
        expect(() => parseSignature("pmr=:not base64!:")).toThrow()
    })
})
