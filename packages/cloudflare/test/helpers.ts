import { runInDurableObject } from "cloudflare:test"
import { PMRObject } from "../src/pmr-object"
import type { SyntheticBehavior } from "@germ-network/atproto-pmr-core"

type RunInDOStub = Parameters<typeof runInDurableObject>[0]

/**
 * `runInDurableObject` constrains its instance type to a `DurableObject`
 * parameterized by the *generated* `Cloudflare.Env`, whose vars are typed as
 * string literals. Our hand-written
 * `PMREnv` types them as `string` — deliberately, since they are
 * parsed at use — so the two do not unify and `PMRObject` fails the constraint.
 *
 * The mismatch is in the type declarations, not in the values, so the cast is
 * contained here rather than pushed into `src/` or repeated at every call
 * site.
 */
export function inPMR<R>(
    stub: DurableObjectStub<PMRObject>,
    fn: (pmr: PMRObject) => R | Promise<R>
): Promise<R> {
    return runInDurableObject(stub as unknown as RunInDOStub, (instance) =>
        fn(instance as unknown as PMRObject)
    )
}

/**
 * Swap in a `SyntheticBehavior` for one test.
 *
 * `synthetic` is `protected` so a deployment sets it by subclassing rather
 * than reaching in; a test legitimately needs to reach in, and the cast is
 * contained here rather than repeated at each call site.
 */
export function withSyntheticBehavior(
    pmr: PMRObject,
    behavior: SyntheticBehavior
): void {
    ;(pmr as unknown as { synthetic: SyntheticBehavior }).synthetic = behavior
}
