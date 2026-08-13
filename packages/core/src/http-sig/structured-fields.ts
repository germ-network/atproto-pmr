/**
 * A deliberately narrow Structured Fields (RFC 9651) parser — only the two
 * shapes RFC 9421 needs:
 *
 *     Signature-Input: label=("@method" "@path");nonce="…";created=1
 *     Signature:       label=:<base64>:
 *
 * This is not a general parser and MUST NOT grow into one by accident. It
 * is the parsing layer of an authentication path, so every construct it
 * does not need is a construct it should reject rather than interpret:
 * a lenient parser here is how two implementations come to disagree about
 * what a single signed request means.
 *
 * Strictness choices, all deliberate:
 *   - no obs-fold handling; a folded header is rejected, not unfolded
 *   - no bare tokens where a string is required
 *   - duplicate dictionary keys and duplicate parameters are rejected
 *     rather than last-one-wins, since a lenient reader and a strict one
 *     would then authenticate different bytes
 */

export type ParamValue = string | number | boolean | Uint8Array

export interface InnerList {
    items: string[]
    params: Map<string, ParamValue>
    /**
     * The member's value exactly as received, from `(` to the end of its
     * parameters.
     *
     * RFC 9421 builds the `@signature-params` line from the signature
     * parameters' serialization. Re-serializing our parse would risk
     * differing from the signer byte-for-byte — a different number of
     * spaces, a different integer form — and the signature would fail for
     * a reason that looks like a key problem. Taking the received bytes
     * verbatim removes that class of failure entirely.
     */
    raw: string
}

class Reader {
    constructor(
        readonly s: string,
        public i = 0
    ) {}
    peek(): string | undefined {
        return this.s[this.i]
    }
    eof(): boolean {
        return this.i >= this.s.length
    }
    ws(): void {
        while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) {
            this.i++
        }
    }
    expect(c: string): void {
        if (this.s[this.i] !== c) {
            throw new Error(`expected ${JSON.stringify(c)} at ${this.i}`)
        }
        this.i++
    }
}

const KEY_RE = /^[a-z*][a-z0-9_\-.*]*$/

function parseKey(r: Reader): string {
    const start = r.i
    while (!r.eof() && /[a-z0-9_\-.*]/.test(r.s[r.i])) r.i++
    const key = r.s.slice(start, r.i)
    if (!KEY_RE.test(key)) throw new Error(`invalid key at ${start}`)
    return key
}

function parseString(r: Reader): string {
    r.expect('"')
    let out = ""
    for (;;) {
        if (r.eof()) throw new Error("unterminated string")
        const c = r.s[r.i++]
        if (c === "\\") {
            const n = r.s[r.i++]
            // RFC 8941: only \" and \\ are legal escapes.
            if (n !== '"' && n !== "\\") throw new Error("bad escape")
            out += n
        } else if (c === '"') {
            return out
        } else {
            const code = c.charCodeAt(0)
            if (code < 0x20 || code > 0x7e) throw new Error("bad string char")
            out += c
        }
    }
}

function parseByteSequence(r: Reader): Uint8Array {
    r.expect(":")
    const start = r.i
    while (!r.eof() && r.s[r.i] !== ":") r.i++
    const b64 = r.s.slice(start, r.i)
    r.expect(":")
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
        throw new Error("invalid byte sequence")
    }
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}

function parseInteger(r: Reader): number {
    const start = r.i
    if (r.peek() === "-") r.i++
    while (!r.eof() && /[0-9]/.test(r.s[r.i])) r.i++
    const text = r.s.slice(start, r.i)
    if (!/^-?\d{1,15}$/.test(text)) throw new Error(`invalid integer at ${start}`)
    return parseInt(text, 10)
}

function parseParams(r: Reader): Map<string, ParamValue> {
    const params = new Map<string, ParamValue>()
    for (;;) {
        if (r.peek() !== ";") return params
        r.i++
        r.ws()
        const key = parseKey(r)
        if (params.has(key)) throw new Error(`duplicate parameter ${key}`)
        if (r.peek() !== "=") {
            // A bare parameter is boolean true.
            params.set(key, true)
            continue
        }
        r.i++
        const c = r.peek()
        if (c === '"') params.set(key, parseString(r))
        else if (c === ":") params.set(key, parseByteSequence(r))
        else if (c === "-" || (c !== undefined && /[0-9]/.test(c))) {
            params.set(key, parseInteger(r))
        } else throw new Error(`unsupported parameter value for ${key}`)
    }
}

/**
 * Parse a Dictionary whose members are Inner Lists of Strings — the
 * `Signature-Input` shape.
 */
export function parseSignatureInput(value: string): Map<string, InnerList> {
    const r = new Reader(value)
    const out = new Map<string, InnerList>()
    r.ws()
    if (r.eof()) return out
    for (;;) {
        const key = parseKey(r)
        if (out.has(key)) throw new Error(`duplicate dictionary key ${key}`)
        r.expect("=")
        const rawStart = r.i
        r.expect("(")
        const items: string[] = []
        for (;;) {
            r.ws()
            if (r.peek() === ")") {
                r.i++
                break
            }
            if (r.eof()) throw new Error("unterminated inner list")
            items.push(parseString(r))
            // Inner-list items may themselves carry parameters; this
            // profile has no use for them, so they are rejected rather
            // than silently dropped from the base we reconstruct.
            if (r.peek() === ";") throw new Error("item parameters unsupported")
        }
        const params = parseParams(r)
        out.set(key, { items, params, raw: r.s.slice(rawStart, r.i) })

        r.ws()
        if (r.eof()) return out
        r.expect(",")
        r.ws()
        if (r.eof()) throw new Error("trailing comma")
    }
}

/** Parse a Dictionary whose members are Byte Sequences — `Signature`. */
export function parseSignature(value: string): Map<string, Uint8Array> {
    const r = new Reader(value)
    const out = new Map<string, Uint8Array>()
    r.ws()
    if (r.eof()) return out
    for (;;) {
        const key = parseKey(r)
        if (out.has(key)) throw new Error(`duplicate dictionary key ${key}`)
        r.expect("=")
        out.set(key, parseByteSequence(r))
        // Parameters on the signature member are permitted by the grammar
        // and unused here; parse and discard so they cannot desync the
        // reader.
        parseParams(r)

        r.ws()
        if (r.eof()) return out
        r.expect(",")
        r.ws()
        if (r.eof()) throw new Error("trailing comma")
    }
}
