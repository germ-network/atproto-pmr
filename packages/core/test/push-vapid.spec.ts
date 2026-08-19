import { p256 } from "@noble/curves/nist.js"
import { describe, expect, it } from "vitest"
import { base64URLToBinary } from "../src/util"
import { signVapidJWT, vapidAuthorizationHeader } from "../src/push/vapid"

const PRIVATE_KEY = p256.utils.randomSecretKey()
const PUBLIC_KEY = p256.getPublicKey(PRIVATE_KEY, false)
const T0 = 1_760_000_000

function decodeJson(base64url: string): unknown {
    return JSON.parse(new TextDecoder().decode(base64URLToBinary(base64url)))
}

describe("signVapidJWT", () => {
    it("produces a three-part JWT with a 64-byte raw r||s signature, never DER", () => {
        const jwt = signVapidJWT({
            audience: "https://push.example",
            subject: "mailto:ops@relay.example",
            expirySeconds: 3600,
            privateKey: PRIVATE_KEY,
            nowSeconds: T0,
        })
        const parts = jwt.split(".")
        expect(parts).toHaveLength(3)
        const sig = base64URLToBinary(parts[2])
        expect(sig.byteLength).toBe(64)
        // A DER signature starts with 0x30 (SEQUENCE tag); a raw r||s
        // signature's first byte is just the top byte of r, essentially
        // never 0x30 for a real key. This is the regression test for the
        // format: 'der' mistake.
        expect(sig[0]).not.toBe(0x30)
    })

    it("header is alg: ES256", () => {
        const jwt = signVapidJWT({
            audience: "https://push.example",
            subject: "mailto:ops@relay.example",
            expirySeconds: 3600,
            privateKey: PRIVATE_KEY,
            nowSeconds: T0,
        })
        const header = decodeJson(jwt.split(".")[0])
        expect(header).toEqual({ typ: "JWT", alg: "ES256" })
    })

    it("payload carries aud, sub, and exp = now + expirySeconds", () => {
        const jwt = signVapidJWT({
            audience: "https://push.example",
            subject: "mailto:ops@relay.example",
            expirySeconds: 3600,
            privateKey: PRIVATE_KEY,
            nowSeconds: T0,
        })
        const payload = decodeJson(jwt.split(".")[1]) as Record<string, unknown>
        expect(payload.aud).toBe("https://push.example")
        expect(payload.sub).toBe("mailto:ops@relay.example")
        expect(payload.exp).toBe(T0 + 3600)
    })

    it("aud is origin-only — no path, no trailing slash", () => {
        const jwt = signVapidJWT({
            audience: new URL("https://push.example/api/v1/subs/abc").origin,
            subject: "mailto:ops@relay.example",
            expirySeconds: 3600,
            privateKey: PRIVATE_KEY,
            nowSeconds: T0,
        })
        const payload = decodeJson(jwt.split(".")[1]) as Record<string, unknown>
        expect(payload.aud).toBe("https://push.example")
    })

    it("refuses an expiry over 24h", () => {
        expect(() =>
            signVapidJWT({
                audience: "https://push.example",
                subject: "mailto:ops@relay.example",
                expirySeconds: 86401,
                privateKey: PRIVATE_KEY,
                nowSeconds: T0,
            })
        ).toThrow()
    })

    it("accepts exactly 24h", () => {
        expect(() =>
            signVapidJWT({
                audience: "https://push.example",
                subject: "mailto:ops@relay.example",
                expirySeconds: 86400,
                privateKey: PRIVATE_KEY,
                nowSeconds: T0,
            })
        ).not.toThrow()
    })

    it("cross-verifies against a WebCrypto ECDSA/JWK verifier — the exact path germ-service uses", async () => {
        const jwt = signVapidJWT({
            audience: "https://push.example",
            subject: "mailto:ops@relay.example",
            expirySeconds: 3600,
            privateKey: PRIVATE_KEY,
            nowSeconds: T0,
        })
        const [header, payload, signatureB64] = jwt.split(".")
        const signature = base64URLToBinary(signatureB64)

        // Import the raw uncompressed public key as a JWK, matching what a
        // verifier without access to raw-key import (Workers' WebCrypto,
        // per push/vapid.ts's module doc) must do.
        const x = PUBLIC_KEY.slice(1, 33)
        const y = PUBLIC_KEY.slice(33, 65)
        const b64url = (b: Uint8Array) =>
            btoa(String.fromCharCode(...b))
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, "")
        const key = await crypto.subtle.importKey(
            "jwk",
            {
                kty: "EC",
                crv: "P-256",
                x: b64url(x),
                y: b64url(y),
                ext: true,
            },
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"]
        )
        const signingInput = new TextEncoder().encode(`${header}.${payload}`)
        const valid = await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            key,
            signature,
            signingInput
        )
        expect(valid).toBe(true)
    })

    it("the public key this suite uses is 65 bytes, 0x04-prefixed — regression guard for the compressed-key gotcha", () => {
        expect(PUBLIC_KEY.byteLength).toBe(65)
        expect(PUBLIC_KEY[0]).toBe(0x04)
    })
})

describe("vapidAuthorizationHeader", () => {
    it("carries both t= and k=", () => {
        const header = vapidAuthorizationHeader("a.b.c", "PUBKEYBASE64URL")
        expect(header).toBe("vapid t=a.b.c, k=PUBKEYBASE64URL")
    })
})
