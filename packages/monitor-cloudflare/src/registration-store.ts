import { base64URLToBinary, binaryToBase64URL } from "@germ-network/atproto-pmr-core"
import type {
    MonitorRegistration,
    MonitorRegistrationStore,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

const REGISTRATION_PREFIX = "mreg:"

/** `KVNamespace` JSON values are not typed for raw bytes — byte fields are
 *  base64url, matching `KVDirectory`'s `GrantAddressRow` convention. */
interface StoredRegistration {
    did: string
    anchorKey: string
    pushSubscription: {
        endpoint: string
        contentKey: string
        keyId: number
    }
    registeredAt: number
}

/**
 * KV-backed reference implementation of the monitor's registration seam.
 *
 * See `MonitorRegistrationStore`'s doc comment (`@germ-network/atproto-pmr-monitor`)
 * for the accepted eventual-consistency risk this adapter carries.
 */
export function kvMonitorRegistrationStore<
    TIngest extends MonitorIngest = MonitorIngest,
>(env: MonitorEnv<TIngest>): MonitorRegistrationStore | null {
    if (env.registrations === undefined) return null
    const kv = env.registrations

    return {
        async load(did: string): Promise<MonitorRegistration | null> {
            const raw = await kv.get<StoredRegistration>(
                REGISTRATION_PREFIX + did,
                "json"
            )
            if (raw === null) return null
            return {
                did: raw.did,
                anchorKey: base64URLToBinary(raw.anchorKey),
                pushSubscription: {
                    endpoint: raw.pushSubscription.endpoint,
                    contentKey: base64URLToBinary(raw.pushSubscription.contentKey),
                    keyId: raw.pushSubscription.keyId,
                },
                registeredAt: raw.registeredAt,
            }
        },

        async put(registration: MonitorRegistration): Promise<void> {
            const row: StoredRegistration = {
                did: registration.did,
                anchorKey: binaryToBase64URL(registration.anchorKey),
                pushSubscription: {
                    endpoint: registration.pushSubscription.endpoint,
                    contentKey: binaryToBase64URL(
                        registration.pushSubscription.contentKey
                    ),
                    keyId: registration.pushSubscription.keyId,
                },
                registeredAt: registration.registeredAt,
            }
            // No TTL, deliberately: unlike a snapshot record, a
            // registration has no natural expiry in v1 (`spec/key-transparency.md`
            // lists registration lifecycle as not-yet-specified) — it is
            // reclaimed only by an explicit DELETE or by the push service's
            // own 404/410 discard.
            await kv.put(REGISTRATION_PREFIX + registration.did, JSON.stringify(row))
        },

        async delete(did: string): Promise<void> {
            await kv.delete(REGISTRATION_PREFIX + did)
        },
    }
}
