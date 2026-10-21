#!/bin/sh
# Produces and checks ml-dsa-65.json with OpenSSL alone (no project code), so
# the vectors do not rest on any implementation that consumes them.
#
#   sh gen-ml-dsa-65.sh           write ml-dsa-65.json next to this script
#   sh gen-ml-dsa-65.sh --check   regenerate in a temp dir and diff against it
#
# OPENSSL selects the binary (default: openssl); it must be 3.5 or later.
set -eu

OPENSSL=${OPENSSL:-openssl}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/ml-dsa-65.json

SEED=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
ZERO_SEED=0000000000000000000000000000000000000000000000000000000000000000

# RFC 9964 Appendix A, Figure 7 (ML_DSA_65, all-zero seed): "raw_public_key"
# and the 'kid' (2) of the COSE_Key.
FIG7_KID=b788acf242f1f1d6532926d816e76e1636874267f2a48c84c4e65789ab80cc02
FIG7_PUB="
    424b2f267e58d5b3b44d71acfc6a656bb26950d57c61db1c880bcfa1feab443f
    0942ab8bdbad7d708abbc356078f6d99a252271fe62c74091eb94afb9b9264c5
    0a888e0dfed80cd5fb2cbd3667e60d539ebe44930219cd4faed15dbb3455a264
    802b9f49bce42ee7550feffdd4642a55ade693868a460cbec03f4fc99a4e30bc
    cffa8a475e5395396674ebb81a94937587880f6dbd27bf1c4f5a9ee43cdd8b0e
    53b3b7fb49c73adfbc2d4f8c54303520c29bf97e26ee57db342d957c89393652
    2d0942b41d82ee3772a00570adfb545c1143922b0496f826a0a970064b36ddf5
    34b5f8e1c1cd0b5565ea846b45431f0618143ece89777bb3f61179ad20295fe0
    a6e062ae6eecbc2ef38f2ac1a22dc93b7b126336223c55b61eb8c0795542bbb2
    dc65e722eadc6866ffa9683beb8a999ad7a83e5e6e016c2e4c35f6f7649ad3bd
    52ec67ec1c5c6e7b9972771218be9554bba7727f0b84c44b9b0a8bd831fcff2c
    9779ccd4ca30c6ad75b04983e41de893ee5f39ea7355180b709c7045c22d33a0
    83f6ae07a114746d1bfdccbee5b9043879bb5a2e120e2a4636283f4a1cd4924a
    2de6a4aa3d99ddd88f48aaa4e88bfd1ea769d82c10779f2ded796db542971ca2
    89b76863ede5997b7e9ce183b43ccec278b10d92b87442ce0435bb1625171db5
    554b470239c50d2a0c3a41b2a38807db070b47bfb3e7d10f3cd979d69963c8d7
    9f8029cc4a48eb04fcb3d708844febaa8b6ddff01ab64d59358e6505c4ec1d7c
    bb14ed2212df458ecefc03fe03037b1505a4c9444322f5f98dfa91a4cb8c4586
    0a2dadc7515350bb6d431e49a6bc8f5ba956e682b0e513321a97d1962602891c
    9078f62a8a9646a31387a6f09684264837899e0d8ec7d11c565901298b20b345
    081690eb4c562c1aa3a25bef06566cb34c79bc0b25e4095d6ba793e81311e41a
    3329152686f00d4897f84fc4edf4b26d545365785ead8d63aef64a87c0b91a2e
    5500383956cdf5f6e37cf9d5482d1c8e3a5be38f17259ac45c9fa1c4bd3bf177
    d312ee52a6da023c05722a8738274dda8d1b04e99831cf57c87282a256c565c2
    96d0524a063a3a41a48a83009978d98d8abf61af68e8013b594fe151d9bec199
    902c4c70b49584201743c6b53103d2fd24bdf078dc90b5a188b4f8d772179988
    d0416c94d4c57c0860b9d7b53d4cd261f332a1851565d52ac37f008747cafe32
    0f363d9beb6e4117db43fd8aeebe5e0ce2f54e3f0367eb3cc971bbe0c301a8e5
    2f96094936035c6ee3ca2d13db483a0dd04dc16247de0e0894ad7cb7e1ae7ebd
    4f8f900582b20021e77f70254501c6ac3dd15d43bbb7931c5283244312158c2e
    b1b3e1117e194f0a1e4c783efbc62c9f81c21562d0d34a5f042b5eaaf32f31f9
    5c5b055f4e7a2070fb096f56c415549cde74f3864e8b9fc27e3299724b463998
    6044b55928fd6972785b280c25a3e21aab814ecbfb0c3cbec0914907ec907f25
    a1d88bce3d319ae8222a35945db62af7cc75cd29c1f5d98fcb93f750dc303107
    6979bb51dfc37d23e8eea78073a24d3e26c68e7bb10e459f2577b90080359ae0
    aec10318dcd9e0f9e34029c31b3e54b1855645db420618783346dad5b55eddb4
    f977b326a655525ebe2195eca9cec38a3c0d2273b77d3e68f1901c2ca5149734
    a51177bcb089476b18cba09fa8b9b46d94a2946f358e1decb1998652c58a9085
    2423e2c85e79d19724461627e6390d1a81fb1a72f9c7edc4bd747dd5c85217b5
    856141028414ddbe71458f0a0b2b589df2e1b051783b8f718676b1defbae98ba
    496c2a935e92eeadea0a8393ef59f9e914f0743fe65640ddf9981cea6dbdd957
    a534ad4e790efc974ee89938ad99d53c5b680775399326834729bb37b082e795
    f8d87f52e6c8a8db68e515c277bbea82a7570d4280896c987a0608903e306c63
    2a223c55f0ea3682039c4a3f5440f4b5ac3e6ed2b2dc900cecc72b72f50e49b2
    629ad30f0487b2707b86286f8c4f55659b25f9bdd7a6af460cc3c57a3982663b
    b717461581e196894929d84153d87a7f482d284b5b894ce1a78216b2a011f2b8
    8742cee52d5133e8fe77edae242f5af91637c37ffca32430509b2fe4756303a9
    a3659fe32528af1e10d8d43bea991b2d109786cc66d35b1d78df254b92cdaa40
    f91a987e4a922ca81050e5bc3530ca85493bdf2a825374d0a8310a6860284ec3
    ec732326eeeffc42bbd42bc91b73e5e7c6b599d016490637629f3876c3e42f8d
    b590e66a85a7838c818f78fffb4853cbef09434989803545dca87657cf7c7e7e
    6afa71382bc10fa0bb6480f243eea1b861101006fa0cff3275621943cc58eb4d
    c3a0428a5e425670fe82268de71c511d8ffbdc11b0d0f961120e971015ad5f44
    8886b802e3fac11672319d487c84f1001339cb969784cb57344f2807f8b425f1
    d73caf8496d742ed237f4c9fcd5a4e84fba7e27fb1a8ae12c4f0427ae24e910d
    951bd8c35d61f8a678db01caea8ef789a95b62ee1b8c5d32c6baa536ba88a107
    0ea61aabbf59294e3f6f974c4c91cafc5bbf6b7ecfd57a18fb7557d71e06e900
    d281b0b49aa00feabb35714af33870edd7ac2393d93177f79ee5606c9df176f0
    25ce49a6e5ff51a2a412ebf86ac0f40471c96ad4c119df230be6173df530ed65
    6cbd8069214741ecdd0271c603fb6c4a8614ff878d33e726cac6693e938ca3fb
    a82c4995c14a2d4af9014fe4c4c50b794cac596b52189f66a7106fb325b526ea
"

# RFC 9881 §2: the SubjectPublicKeyInfo of an ML-DSA-65 key is this fixed
# header (OID 2.16.840.1.101.3.4.3.18, parameters absent) over the 1952-byte key.
SPKI_PREFIX=308207b2300b0609608648016503040312038207a100

# RFC 9964 §3, §6: {1: 7, 3: -49, -1: h'<1952 bytes>'} in RFC 8949 §4.2.1 order.
COSE_PREFIX=a30107033830205907a0

METHOD=POST
AUTHORITY=pmr.example
REQ_PATH=/pmr/v1/registrations
BODY_HEX=a1616101
NONCE=dGVzdC1jaGFsbGVuZ2U
CREATED=1754960000
LABEL=pmr

die() { echo "gen-ml-dsa-65: $*" >&2; exit 1; }

case $($OPENSSL version) in
    "OpenSSL 3."[5-9]* | "OpenSSL "[4-9]*) ;;
    *) die "need OpenSSL >= 3.5 (got: $($OPENSSL version))" ;;
esac
OPENSSL_VERSION=$($OPENSSL version | cut -d' ' -f2)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

hex() { xxd -p "$1" | tr -d '\n'; }
unhex() { printf %s "$1" | xxd -r -p > "$2"; }
b64() { $OPENSSL base64 -A -in "$1"; }
b64url() { b64 "$1" | tr '+/' '-_' | tr -d '='; }
sha256_file() { $OPENSSL dgst -sha256 -binary "$1" > "$2"; }

# keygen SEED PREFIX -> PREFIX.pem, PREFIX.pub.pem, PREFIX.pub (raw 1952 bytes)
keygen() {
    $OPENSSL genpkey -algorithm ML-DSA-65 -pkeyopt "hexseed:$1" -out "$TMP/$2.pem"
    $OPENSSL pkey -in "$TMP/$2.pem" -pubout -out "$TMP/$2.pub.pem"
    $OPENSSL pkey -in "$TMP/$2.pem" -pubout -outform DER -out "$TMP/$2.spki"
    [ $(wc -c < "$TMP/$2.spki") -eq 1974 ] || die "unexpected SPKI length"
    [ "$(head -c 22 "$TMP/$2.spki" | xxd -p | tr -d '\n')" = "$SPKI_PREFIX" ] ||
        die "SPKI header is not the RFC 9881 §2 ML-DSA-65 header"
    tail -c 1952 "$TMP/$2.spki" > "$TMP/$2.pub"
}

# sign KEYPREFIX BASEFILE OUTFILE [extra pkeyutl option]
sign() {
    set -- "$1" "$2" "$3" "${4-}"
    if [ -n "$4" ]; then
        $OPENSSL pkeyutl -sign -inkey "$TMP/$1.pem" -rawin -in "$2" -out "$3" \
            -pkeyopt deterministic:1 -pkeyopt "$4"
    else
        $OPENSSL pkeyutl -sign -inkey "$TMP/$1.pem" -rawin -in "$2" -out "$3" \
            -pkeyopt deterministic:1
    fi
}

# verifies KEYPREFIX BASEFILE SIGFILE [extra pkeyutl option]: exit status only
verifies() {
    set -- "$1" "$2" "$3" "${4-}"
    if [ -n "$4" ]; then
        $OPENSSL pkeyutl -verify -pubin -inkey "$TMP/$1.pub.pem" -rawin -in "$2" \
            -sigfile "$3" -pkeyopt "$4" > /dev/null 2>&1
    else
        $OPENSSL pkeyutl -verify -pubin -inkey "$TMP/$1.pub.pem" -rawin -in "$2" \
            -sigfile "$3" > /dev/null 2>&1
    fi
}

must_verify() { verifies "$@" || die "expected a valid signature: $*"; }
must_refuse() { ! verifies "$@" || die "expected a refused signature: $*"; }

# --- RFC 9964 Figure 7: keygen and thumbprint against the RFC's own values.
keygen "$ZERO_SEED" fig7
FIG7_PUB=$(printf %s "$FIG7_PUB" | tr -d ' \n')
[ "$(hex "$TMP/fig7.pub")" = "$FIG7_PUB" ] || die "Figure 7: keygen does not give the RFC's pub"
unhex "${COSE_PREFIX}${FIG7_PUB}" "$TMP/fig7.thumb_input"
sha256_file "$TMP/fig7.thumb_input" "$TMP/fig7.kid"
[ "$(hex "$TMP/fig7.kid")" = "$FIG7_KID" ] || die "Figure 7: thumbprint does not give the RFC's kid"

# --- The project key.
keygen "$SEED" key
PUB=$(hex "$TMP/key.pub")
unhex "${COSE_PREFIX}${PUB}" "$TMP/key.cose"
COSE_KEY=$(hex "$TMP/key.cose")
sha256_file "$TMP/key.cose" "$TMP/key.thumb"
THUMB_HEX=$(hex "$TMP/key.thumb")
THUMB_B64URL=$(b64url "$TMP/key.thumb")

# --- The request.
unhex "$BODY_HEX" "$TMP/body"
sha256_file "$TMP/body" "$TMP/body.sha256"
CONTENT_DIGEST="sha-256=:$(b64 "$TMP/body.sha256"):"
COMPONENTS='("@method" "@authority" "@path" "content-digest")'

# build_request ALG -> sets SIG_PARAMS, SIGNATURE_INPUT, and writes the base to $TMP/base.ALG
build_request() {
    SIG_PARAMS="$COMPONENTS;nonce=\"$NONCE\";created=$CREATED;keyid=\"$THUMB_B64URL\";alg=\"$1\""
    SIGNATURE_INPUT="$LABEL=$SIG_PARAMS"
    printf '"@method": %s\n"@authority": %s\n"@path": %s\n"content-digest": %s\n"@signature-params": %s' \
        "$METHOD" "$AUTHORITY" "$REQ_PATH" "$CONTENT_DIGEST" "$SIG_PARAMS" > "$TMP/base.$1"
}

build_request ml-dsa-65
BASE=$(cat "$TMP/base.ml-dsa-65")
SIGNATURE_INPUT_VALID=$SIGNATURE_INPUT
cp "$TMP/base.ml-dsa-65" "$TMP/base"

# --- Signatures.
sign key "$TMP/base" "$TMP/sig.valid"
sign key "$TMP/base" "$TMP/sig.valid2"
cmp -s "$TMP/sig.valid" "$TMP/sig.valid2" || die "deterministic signing is not repeatable"
[ $(wc -c < "$TMP/sig.valid") -eq 3309 ] || die "unexpected signature length"
must_verify key "$TMP/base" "$TMP/sig.valid"
must_refuse key "$TMP/base" "$TMP/sig.valid" context-string:pmr

sign key "$TMP/base" "$TMP/sig.ctx" context-string:pmr
must_verify key "$TMP/base" "$TMP/sig.ctx" context-string:pmr
must_refuse key "$TMP/base" "$TMP/sig.ctx"

FIRST=$(head -c 1 "$TMP/sig.valid" | xxd -p)
FLIPPED=$(printf '%02x' $(( 0x$FIRST ^ 1 )))
{ printf %s "$FLIPPED" | xxd -r -p; tail -c +2 "$TMP/sig.valid"; } > "$TMP/sig.flipped"
must_refuse key "$TMP/base" "$TMP/sig.flipped"

# The valid signature carried on a request whose alg is relabelled. OpenSSL
# accepts the bytes over the original base and refuses them over the
# relabelled base: the refusal a verifier owes is the profile's, made before
# any signature check.
build_request ed25519
SIGNATURE_INPUT_RELABELLED=$SIGNATURE_INPUT
BASE_RELABELLED=$(cat "$TMP/base.ed25519")
must_verify key "$TMP/base" "$TMP/sig.valid"
must_refuse key "$TMP/base.ed25519" "$TMP/sig.valid"

# --- Assemble.
jq -n \
    --arg openssl "$OPENSSL_VERSION" \
    --arg seed "$SEED" --arg pub "$PUB" --arg cose "$COSE_KEY" \
    --arg thumb_hex "$THUMB_HEX" --arg thumb_b64url "$THUMB_B64URL" \
    --arg zero_seed "$ZERO_SEED" --arg fig7_pub "$FIG7_PUB" --arg fig7_kid "$FIG7_KID" \
    --arg method "$METHOD" --arg authority "$AUTHORITY" --arg path "$REQ_PATH" \
    --arg body "$BODY_HEX" --arg digest "$CONTENT_DIGEST" --arg nonce "$NONCE" \
    --argjson created "$CREATED" --arg label "$LABEL" \
    --arg si "$SIGNATURE_INPUT_VALID" --arg base "$BASE" \
    --arg si_rel "$SIGNATURE_INPUT_RELABELLED" --arg base_rel "$BASE_RELABELLED" \
    --arg valid_hex "$(hex "$TMP/sig.valid")" --arg valid_b64 "$(b64 "$TMP/sig.valid")" \
    --arg ctx_hex "$(hex "$TMP/sig.ctx")" --arg ctx_b64 "$(b64 "$TMP/sig.ctx")" \
    --arg flip_hex "$(hex "$TMP/sig.flipped")" --arg flip_b64 "$(b64 "$TMP/sig.flipped")" '
{
  description: "ML-DSA-65 (RFC 9964 AKP, alg -49) known-answer vectors. Produced and checked by gen-ml-dsa-65.sh with OpenSSL alone.",
  openssl: $openssl,
  context: "",
  rfc9964_figure7: {
    note: "RFC 9964 Appendix A, Figure 7 (ML_DSA_65): the all-zero seed, its raw public key, and the COSE_Key kid (the RFC 9679 thumbprint over {kty, alg, pub}). Copied from the RFC text; not the project key.",
    seed: $zero_seed,
    pub: $fig7_pub,
    kid: $fig7_kid
  },
  key: {
    seed: $seed,
    pub: $pub,
    cose_key: $cose,
    thumbprint_input: $cose,
    thumbprint_hex: $thumb_hex,
    thumbprint_b64url: $thumb_b64url
  },
  request: {
    method: $method,
    url: ("https://" + $authority + $path),
    authority: $authority,
    path: $path,
    body_hex: $body,
    content_digest: $digest,
    label: $label,
    nonce: $nonce,
    created: $created,
    keyid: $thumb_b64url,
    alg: "ml-dsa-65",
    signature_input: $si,
    signature_base: $base
  },
  valid: [
    {
      name: "deterministic",
      why: "Pure ML-DSA-65, empty context, deterministic signing (all-zero randomness). Another implementation signing hedged will not reproduce these bytes; treat them as verify-only.",
      signature_hex: $valid_hex,
      signature_b64: $valid_b64
    }
  ],
  invalid: [
    {
      name: "context-pmr",
      why: "Signed with context string \"pmr\". The profile requires the empty context, so this must be refused; it verifies only with context-string:pmr.",
      signature_hex: $ctx_hex,
      signature_b64: $ctx_b64
    },
    {
      name: "bit-flipped",
      why: "The valid signature with the low bit of its first byte flipped.",
      signature_hex: $flip_hex,
      signature_b64: $flip_b64
    },
    {
      name: "alg-relabelled",
      why: "The valid signature carried on a request whose alg is relabelled ed25519. The signature verifies over the original base only, not over this relabelled one; the verifier refuses it on profile grounds, before any signature check, because alg ed25519 does not match an AKP/ML-DSA-65 key.",
      signature_hex: $valid_hex,
      signature_b64: $valid_b64,
      alg: "ed25519",
      signature_input: $si_rel,
      signature_base: $base_rel
    }
  ]
}' > "$TMP/out.json"

if [ "${1-}" = "--check" ]; then
    diff "$TMP/out.json" "$OUT" > /dev/null || die "$OUT is out of date; re-run without --check and review the diff"
    echo "ok: $OUT matches OpenSSL $OPENSSL_VERSION"
else
    cp "$TMP/out.json" "$OUT"
    echo "wrote $OUT (OpenSSL $OPENSSL_VERSION)"
fi
