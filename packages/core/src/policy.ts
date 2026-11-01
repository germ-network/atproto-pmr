/**
 * The allow-policy vocabulary shared by the "can A message B?" oracle and the
 * stores that keep a declaration's decoded policies.
 */

/**
 * An allow policy B declares:
 * - `open` — anyone may message B.
 * - `bsky-follows` — A may message B if B follows A on `app.bsky.graph`.
 *
 * Open: a policy this relay does not know is reported as `pending`, never as
 * admitting or refusing.
 */
export type AllowPolicy = "open" | "bsky-follows" | (string & {})

/** What B declares, as a policy source reads it. */
export type DeclaredPolicies =
    | { found: true; policies: AllowPolicy[] }
    | { found: false; code: "no-declaration" | "unavailable" | "undecodable" }

/** The form kept beside a stored declaration: decoded, or not decodable. */
export type StoredPolicies =
    | Extract<DeclaredPolicies, { found: true }>
    | { found: false; code: "undecodable" }
