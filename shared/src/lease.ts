import { z } from 'zod'

/**
 * A KeyGrant lease is a signed JWT (JWS, EdDSA/Ed25519). The client verifies it
 * OFFLINE against the product's public key and trusts it until `exp`. Lease TTL
 * is therefore the offline grace window.
 *
 * Claim names are kept short (JWT convention) but explicit. Standard registered
 * claims (iss/sub/iat/exp) plus KeyGrant-namespaced private claims.
 */

export const LICENSE_MODELS = ['perpetual', 'subscription', 'trial'] as const
export type LicenseModel = (typeof LICENSE_MODELS)[number]

export const ISSUER = 'keygrant' as const

/**
 * The highest real major version anything accepts: a request body, a licence
 * model, a key's range. Far past any version a desktop app will reach, and well
 * below `OPEN_MAJOR`, so the two can never be confused.
 */
export const MAX_MAJOR = 99_999

/**
 * The longest licence key an SDK sends and a licence file may carry (UTF-16
 * units). The worker's request schemas hold keys to the same 120 with literals
 * of their own, which must stay equal to this.
 */
export const MAX_LICENSE_KEY = 120

/**
 * The longest product slug a licence file names. The worker's schemas hold
 * slugs to the same 64 with literals of their own, which must stay equal to this.
 */
export const MAX_PRODUCT_SLUG = 64

/**
 * The lease's `major` claim for a key with no upper bound ("version 2 and
 * later", or a subscription that covers whatever ships while it is paid). Above
 * every real major, so any SDK that compares its running major against the
 * claim lets every future version through as the key intends.
 */
export const OPEN_MAJOR = 1_000_000

/** Seconds-since-epoch. JWT time claims are numeric dates (RFC 7519 §2). */
const NumericDate = z.number().int().nonnegative()

/** One entitlement's value: a flag, a number or a text. */
export type Entitlement = boolean | number | string

/**
 * A lease's entitlements (its `ent` claim): what the licence grants beyond the
 * base product, by name (`{ edition: 'pro', seats: 5 }`). Empty for the base
 * product. Read-only: an SDK hands it to the app as the lease signed it.
 */
export type Entitlements = Readonly<Record<string, Entitlement>>

/** A text with a lone surrogate (half of a pair, not a character), which `\p{Cs}` matches only alone under `u`. */
const LONE_SURROGATE = /\p{Cs}/u

/** Whether an entitlement's name or text is one every SDK reads the same: whole characters only. */
const wellFormed = (text: string) => !LONE_SURROGATE.test(text)

/**
 * Whether an entitlement's name is one no SDK can confuse with another: whole
 * characters, in Unicode's composed form (NFC). Swift compares the keys of a
 * dictionary by canonical equivalence, so two names that differ only in how a
 * character is composed (`\u00e9` and `e\u0301`, or `K` and the Kelvin sign)
 * would be one entitlement there and two everywhere else; distinct names in
 * NFC are never canonically equivalent.
 */
const wellFormedName = (name: string) => wellFormed(name) && name === name.normalize('NFC')

/**
 * `ent` as the server signs it: an object of flags, finite numbers and texts,
 * and nothing else (`signLease` refuses any other). A strict reader may
 * refuse a whole lease whose `ent` is not this, so the server never signs one.
 *
 * Three refusals JSON would otherwise hide: a number that is not finite
 * (`JSON.stringify` writes Infinity and NaN as `null`, which a strict reader
 * refuses); a member named `__proto__` (`z.record` builds its result by
 * assignment, which takes that name for the object's prototype and signs a
 * lease without it, though a verifier keeps the name); and a name or a text
 * with a lone surrogate (`JSON.stringify` writes it as a `\ud800` escape, which
 * the Rust and C++ SDKs' JSON readers refuse outright, so the whole lease would
 * be refused there, and the others read it each their own way). A name must
 * also be in Unicode's composed form (`wellFormedName`).
 */
export const SignedEntitlements = z
  .unknown()
  .refine((raw) => typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, '__proto__'), {
    message: 'an entitlement may not be named __proto__',
  })
  .pipe(
    z
      .record(z.union([z.boolean(), z.number().finite(), z.string().refine(wellFormed, 'a text with a lone surrogate')]))
      .refine((ent) => Object.keys(ent).every(wellFormedName), 'a name with a lone surrogate, or not in NFC'),
  )

/**
 * The caps the server holds entitlements to where they are SET: a licence
 * model's, a key's own and a product's trial entitlements. At most 16 of them,
 * each name 1 to 32 characters and each text at most 64, counted in UTF-16
 * units as JavaScript counts a string's length. Only where they are set: an SDK
 * reads whatever a lease it verifies carries, so a later server may raise these
 * without locking out an app built before.
 */
export const ENTITLEMENT_LIMITS = { entries: 16, nameLength: 32, textLength: 64 } as const

/**
 * Entitlements as the server takes them where they are set: exactly what
 * `signLease` signs (`SignedEntitlements`, the same schema, not a copy of it),
 * within `ENTITLEMENT_LIMITS`. Every write holds a value to this, so one the
 * signer would refuse is refused when it is saved (`400 invalid-request`), and
 * signing the lease of a key that carries it never fails for it.
 */
export const SettableEntitlements = SignedEntitlements.superRefine((ent, ctx) => {
  const names = Object.keys(ent)
  if (names.length > ENTITLEMENT_LIMITS.entries) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${ENTITLEMENT_LIMITS.entries} entitlements` })
  }
  for (const name of names) {
    if (name.length < 1 || name.length > ENTITLEMENT_LIMITS.nameLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `a name of 1 to ${ENTITLEMENT_LIMITS.nameLength} characters` })
    }
    const value = ent[name]
    if (typeof value === 'string' && value.length > ENTITLEMENT_LIMITS.textLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `a text of at most ${ENTITLEMENT_LIMITS.textLength} characters` })
    }
  }
})

const isEntitlement = (value: unknown): value is Entitlement =>
  typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'

/**
 * `ent` as a verifier reads it: an object's flag, number and text members, kept
 * as they are; every other member (an object, a list, null) dropped; and
 * nothing at all from anything but an object (absent, null, a list, a text, a
 * number, a flag). Never a refusal: a lease that verifies is the server's word,
 * and one malformed entitlement must not take away the licence it rides on, or
 * the entitlements beside it.
 *
 * Built with `Object.fromEntries`, so a member named `__proto__` is an
 * entitlement like any other, never the object's prototype. A number past a
 * double's range is not a case: the server writes its JSON with
 * `JSON.stringify`, which never writes one.
 */
export function entitlementsOf(raw: unknown): Entitlements {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => isEntitlement(value)))
}

/**
 * A lease's claims as a verifier reads them (`verifyLease`). Unknown claims are
 * ignored, `major` defaults to 0, and `ent`, the entitlements, is read
 * leniently (`entitlementsOf`).
 */
export const LeaseClaims = z.object({
  /** Issuer: always "keygrant". */
  iss: z.literal(ISSUER),
  /** Subject: the licence key, e.g. "SLUICE-XXXX-XXXX-XXXX-XXXX". */
  sub: z.string().min(1),
  /** Product identifier (slug) the lease is scoped to. */
  product: z.string().min(1),
  /** Activation id: the specific device slot this lease was issued to. */
  aid: z.string().min(1),
  /**
   * The device the activation belongs to: a hash of the fingerprint the SDK
   * sent when it activated (`fingerprintClaim`), never the fingerprint itself,
   * since the payload of a lease is readable by anyone holding it. The SDK
   * refuses a lease whose `fp` is not its own device's, so a state file
   * copied to another machine does not license it. Absent on trial leases and
   * may be absent on a licence lease; an SDK accepts a licence lease without
   * it, which lasts only until its renewal brings one with it.
   */
  fp: z.string().min(1).max(128).optional(),
  /**
   * What `fp` hashes: `machine`, the operating system's machine id, or
   * `hostname`, the host name (the fingerprint when a machine has no id to
   * read). Only a lease whose seat is keyed by a machine id is held to its
   * device: a host name changes with a rename or an architecture switch, and an
   * honest device must never be refused for that. Absent: not held either (a
   * lease with no device claim, or a seat whose kind is unknown).
   */
  fpk: z.enum(['machine', 'hostname']).optional(),
  /** Licence model. */
  model: z.enum(LICENSE_MODELS),
  /** Max devices allowed on the parent licence. */
  lim: z.number().int().positive(),
  /**
   * Highest app major version this licence covers, its upgrade protection
   * included; `OPEN_MAJOR` when it has no upper bound. The client compares its
   * own running major against this.
   */
  major: z.number().int().nonnegative().default(0),
  /**
   * Lowest app major version this licence covers, present only when it is above
   * 1 (a key sold for 2.x, or for "3 and later"). A build older than this is
   * refused offline as out of date rather than as needing an upgrade. Absent
   * means 1, which is also how an SDK that does not read the claim takes it.
   */
  minMajor: z.number().int().positive().optional(),
  /**
   * When the key's upgrade protection ends, in SECONDS since the epoch like
   * `exp`. Present only while that window is open, which is why `major` is
   * `OPEN_MAJOR`: the key runs every version until then, and keeps the newest
   * major its customer ran in it. An SDK keeps note of that major (its
   * `keptMajor`) while its clock is before this, and reports it at its next
   * validate, so a version first run offline late in the window is still kept
   * when the window has closed by the time the app renews. Absent: no open
   * window, and nothing to note.
   */
  upgradeUntil: NumericDate.optional(),
  /**
   * Feature entitlements; an empty object is the base product. Read leniently
   * (`entitlementsOf`): absent or malformed is `{}`, and a malformed member is
   * dropped, never the lease. Signed strictly (`SignableClaims`).
   */
  ent: z.unknown().transform(entitlementsOf),
  /** Issued-at. */
  iat: NumericDate,
  /** Expiry: when the client must re-check in (the grace boundary). */
  exp: NumericDate,
  /**
   * True when the licence is past its expiry but still inside the grace window
   * its terms grant. The lease is fully valid; the SDK should nag rather than
   * lock, which is the whole point of grace (fail in favour of the customer).
   * Absent means not in grace.
   */
  grace: z.boolean().optional(),
  /**
   * True on a TEST licence: one a developer made to exercise their own app (a
   * scenario from the dashboard, a `kg_test_` API key, or a Stripe test-mode
   * checkout). It is signed with the product's real key so it works in the build
   * they ship, lapses on its own within 30 days, and is never counted or billed.
   * A release build that wants nothing to do with them refuses any lease
   * carrying this. Absent means a real licence.
   */
  test: z.boolean().optional(),
})

/**
 * The claims `signLease` signs: as read, but `ent` held to what the server
 * signs (`SignedEntitlements`), absent being `{}`, so a malformed one is an
 * error here rather than a lease every SDK has to make sense of. `ent` keeps
 * its place among the claims (an `extend` replaces a key where it stands), so
 * a signed payload's members come in the order they always have.
 */
export const SignableClaims = LeaseClaims.extend({ ent: SignedEntitlements.default({}) })

export type LeaseClaims = z.infer<typeof LeaseClaims>

/** Input to sign a lease; iss/iat/exp are filled by the signer. */
export type LeaseInput = Omit<LeaseClaims, 'iss' | 'iat' | 'exp'> & {
  /**
   * Lease lifetime in seconds: the key's offline days, else its type's
   * default (`DEFAULT_TTL_SECONDS`), never past the key's own stop.
   */
  ttlSeconds: number
}

/**
 * The lease length of a key whose licence model sets no offline days, by type
 * (seconds). A model's own offline days, 1 to 90, replace it for the keys sold
 * under it.
 */
export const DEFAULT_TTL_SECONDS: Record<LicenseModel, number> = {
  perpetual: 30 * 24 * 60 * 60,
  subscription: 7 * 24 * 60 * 60,
  trial: 7 * 24 * 60 * 60,
}
