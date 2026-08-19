import {
    base64URLToBinary,
    deliverPush,
    sealPushPayload,
    signVapidJWT,
    vapidAuthorizationHeader,
    type DeliverPushResult,
} from "@germ-network/atproto-pmr-core"
import type { DeclarationPushSender, MonitorRegistration } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

/** Matches `@germ-network/atproto-pmr-cloudflare`'s `push-sender.ts` — kept
 *  in sync deliberately rather than shared, since the two adapters must
 *  never depend on each other (a standalone monitor has no `PMRObject`). */
const VAPID_JWT_EXPIRY_SECONDS = 12 * 60 * 60

/**
 * A constant Topic per RFC 8030: a burst of `t:"d"` pushes to the same
 * subscription (a hostile or misbehaving PDS churning declaration revs,
 * for instance) collapses at the push service to whichever arrives last,
 * rather than each one separately eating into the subscription's daily
 * push-service quota. Every `t:"d"` push means exactly the same thing —
 * "re-fetch and verify" — so collapsing them loses nothing a device needs.
 */
const DECLARATION_CHANGE_TOPIC = "d"

/**
 * Composes the core Web Push primitives against this Worker's env and
 * `fetch` global — the monitor-side counterpart to
 * `@germ-network/atproto-pmr-cloudflare`'s `webPushSender`, re-derived
 * rather than imported (that package is not a dependency here; a
 * standalone monitor deployment has no `PMRObject`).
 *
 * Returns `null` when the deployment has not configured push, matching the
 * PMR side's "not configured → no-op" contract.
 *
 * All of `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
 * `PUSH_MAX_SEALED_BYTES`, `PUSH_TTL_SECONDS`, and `HOST_NAME` are required
 * together, and intentionally the same env var names the PMR uses — a
 * deployment that co-hosts both a relay and a monitor configures push once
 * and satisfies both interfaces from the same env.
 */
export function monitorWebPushSender<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): DeclarationPushSender | null {
    if (
        env.VAPID_PUBLIC_KEY === undefined ||
        env.VAPID_PRIVATE_KEY === undefined ||
        env.VAPID_SUBJECT === undefined ||
        env.PUSH_MAX_SEALED_BYTES === undefined ||
        env.PUSH_TTL_SECONDS === undefined ||
        env.HOST_NAME === undefined
    ) {
        return null
    }

    const maxSealedBytes = parseInt(env.PUSH_MAX_SEALED_BYTES)
    const ttlSeconds = parseInt(env.PUSH_TTL_SECONDS)
    if (!Number.isFinite(maxSealedBytes) || !Number.isFinite(ttlSeconds)) {
        return null
    }

    const publicKey = env.VAPID_PUBLIC_KEY
    const privateKey = base64URLToBinary(env.VAPID_PRIVATE_KEY)
    const subject = env.VAPID_SUBJECT
    const hostAad = new TextEncoder().encode(env.HOST_NAME)

    return {
        async send(
            subscription: MonitorRegistration["pushSubscription"],
            plaintext: Uint8Array
        ): Promise<DeliverPushResult> {
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
                topic: DECLARATION_CHANGE_TOPIC,
            })
        },
    }
}
