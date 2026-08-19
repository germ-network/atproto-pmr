import {
    base64URLToBinary,
    deliverPush,
    sealPushPayload,
    signVapidJWT,
    vapidAuthorizationHeader,
    type DeliverPushResult,
} from "@germ-network/atproto-pmr-core"
import type { PMRObject } from "./pmr-object"
import type { PMREnv } from "./env"

/** How long a VAPID JWT stays valid — comfortably inside push services'
 * 24-hour ceiling and any plausible clock skew, and re-derived fresh per
 * delivery rather than cached, since sealing is already on the deferred
 * path and a cache would need its own invalidation story for no benefit. */
const VAPID_JWT_EXPIRY_SECONDS = 12 * 60 * 60

export interface PushSubscription {
    endpoint: string
    contentKey: Uint8Array
    keyId: number
}

export interface PushSender {
    /** The push service's payload ceiling, in bytes — for building the
     * best-fitting plaintext before sealing (`push/payload.ts`). */
    readonly maxSealedBytes: number
    send(
        subscription: PushSubscription,
        plaintext: Uint8Array
    ): Promise<DeliverPushResult>
}

/**
 * Composes the core Web Push primitives against this Worker's env and
 * `fetch` global. Returns `null` when the deployment has not configured
 * push — the caller (`PMRObject.deliverPush`) treats a `null` sender as a
 * no-op, matching `deliverLive`'s "an adapter with no concept omits it"
 * contract.
 *
 * All of `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
 * `PUSH_MAX_SEALED_BYTES`, and `PUSH_TTL_SECONDS` are required together —
 * a deployment either delegates push fully configured, or not at all.
 * Partial configuration is treated the same as none, rather than failing
 * differently per missing field.
 */
export function webPushSender<TPMR extends PMRObject>(
    env: PMREnv<TPMR>
): PushSender | null {
    if (
        env.VAPID_PUBLIC_KEY === undefined ||
        env.VAPID_PRIVATE_KEY === undefined ||
        env.VAPID_SUBJECT === undefined ||
        env.PUSH_MAX_SEALED_BYTES === undefined ||
        env.PUSH_TTL_SECONDS === undefined
    ) {
        return null
    }

    const publicKey = env.VAPID_PUBLIC_KEY
    const privateKey = base64URLToBinary(env.VAPID_PRIVATE_KEY)
    const subject = env.VAPID_SUBJECT
    const maxSealedBytes = parseInt(env.PUSH_MAX_SEALED_BYTES)
    const ttlSeconds = parseInt(env.PUSH_TTL_SECONDS)
    const hostAad = new TextEncoder().encode(env.HOST_NAME)

    return {
        maxSealedBytes,
        async send(subscription, plaintext) {
            const sealed = sealPushPayload(plaintext, {
                contentKey: subscription.contentKey,
                keyId: subscription.keyId,
                randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
                maxSealedBytes,
                aad: hostAad,
            })

            const audience = new URL(subscription.endpoint).origin
            const jwt = signVapidJWT({
                audience,
                subject,
                expirySeconds: VAPID_JWT_EXPIRY_SECONDS,
                privateKey,
                nowSeconds: Math.floor(Date.now() / 1000),
            })

            return deliverPush(subscription.endpoint, sealed, {
                fetchImpl: fetch,
                authorizationHeader: vapidAuthorizationHeader(jwt, publicKey),
                ttlSeconds,
            })
        },
    }
}
