import { decodeCoseMap, encodeCose, type CoseValue } from "./cose/cbor.js"
import { readBodyCapped, toResponseBody } from "./util.js"
import {
    mintChallenge,
    nextChallengeHeaderValue,
    NEXT_CHALLENGE_HEADER,
    type ChallengeBinding,
    type MintDeps,
    type MintedChallenge,
    type Realm,
} from "./challenge.js"

/**
 * `POST /pmr/v1/challenges` — `spec/wire-api.md`, "Freshness and replay".
 *
 * PROVISIONAL BODY SHAPE. The specification is an endpoint inventory, not
 * an IDL: concrete CBOR body schemas are listed as not yet specified, and
 * publishing them is tracked separately. The shape below is the minimum
 * that expresses a binding, chosen so that settling the schema later is a
 * decode change rather than a redesign:
 *
 *     request   { "r": realm, "s": subject }
 *     response  { "c": challenge, "e": expiresAt }
 *
 * Single-letter keys follow the wire vocabulary already used for puts.
 */

const CHALLENGE_REQUEST_MAX_BYTES = 1024

export interface ChallengeEndpointDeps extends Omit<MintDeps, "nowSeconds"> {
    nowSeconds: number
    /**
     * Which realms this deployment serves. An Atproto PMR serves exactly
     * one — `anchor` — and MUST refuse a mint for a realm it does not
     * implement rather than issuing a challenge nothing can redeem.
     */
    servedRealms: readonly Realm[]
    /**
     * Deployment policy, applied BEFORE a challenge exists. This is the
     * point of a server-issued challenge: the mint is where a server
     * declines or rate-limits, before any body is parsed downstream and
     * before the client can pre-sign anything.
     *
     * Return `false` to refuse. Defaults to accepting.
     */
    admit?: (binding: ChallengeBinding) => boolean | Promise<boolean>
}

export async function handleChallengeMint(
    request: Request,
    deps: ChallengeEndpointDeps
): Promise<Response> {
    let binding: ChallengeBinding
    try {
        const bytes = await readBodyCapped(request, CHALLENGE_REQUEST_MAX_BYTES)
        const map = decodeCoseMap(bytes)
        const realm = map.get("r")
        const subject = map.get("s")
        if (typeof realm !== "string" || typeof subject !== "string") {
            return new Response("Malformed challenge request", { status: 400 })
        }
        if (realm !== "anchor" && realm !== "registration") {
            return new Response("Unknown realm", { status: 400 })
        }
        if (subject.length === 0) {
            return new Response("Malformed challenge request", { status: 400 })
        }
        binding = { realm, subject }
    } catch (e) {
        return new Response(`Malformed challenge request: ${String(e)}`, {
            status: 400,
        })
    }

    // A realm this deployment does not implement is refused rather than
    // served: issuing a challenge no verifier here could redeem would be a
    // silent dead end for the client.
    if (!deps.servedRealms.includes(binding.realm)) {
        return new Response("Realm not served", { status: 400 })
    }

    if (deps.admit !== undefined && !(await deps.admit(binding))) {
        // The mint is the control point. Declining here costs the caller a
        // round trip and produces nothing they can sign with.
        return new Response("Refused", { status: 429 })
    }

    const minted = await mintChallenge(binding, deps)
    return new Response(
        toResponseBody(
            encodeCose(
                new Map<string, CoseValue>([
                    ["c", minted.challenge],
                    ["e", minted.expiresAt],
                ])
            )
        ),
        {
            status: 200,
            headers: {
                "content-type": "application/cbor",
                "cache-control": "no-store",
            },
        }
    )
}

/**
 * Attach a freshly minted challenge to an authenticated response, so the
 * client never pays the mint round trip again.
 */
export function withNextChallenge(
    response: Response,
    minted: MintedChallenge
): Response {
    const headers = new Headers(response.headers)
    headers.set(NEXT_CHALLENGE_HEADER, nextChallengeHeaderValue(minted))
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}
