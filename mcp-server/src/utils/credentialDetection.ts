/**
 * CREDENTIAL DETECTION — the ONE detector for "is there a credential in this stored value?"
 *.
 *
 * A past incident / CLASSES.md C5 (centralize the guard, don't drift N copies): every place that
 * must make this decision calls THESE functions. The vocabulary (which shapes count as a
 * credential) lives in config/credentialDetectionConfig.ts (configs-not-hardcoded); this
 * module is the pure logic, and it is deliberately tiny.
 *
 * ── THE ONE RULE THIS MODULE MUST NEVER BREAK ─────────────────────────────────────────────
 * IT RETURNS IDS, NEVER MATCHED TEXT. the token never enters the transcript, and
 * a rejection message IS a transcript — it goes back to the model, into logs, and often into
 * the next record. A caller cannot leak what it was never handed, which is why the return
 * type is `string[]` of signature ids and there is no "matched value" field to be tempted by.
 *
 * ── PRECISION, NOT RECALL ─────────────────────────────────────────────────────────────────
 * Read the header of config/credentialDetectionConfig.ts before changing anything here. The
 * failure mode this guard is written against is being OVER-BROAD, not missing a token: the
 * highest-value field it scans (`metadata.capture.evidence`) is pasted command output by
 * design. A bare hex blob is an accepted miss, bought deliberately.
 *
 * This scan is NOT code-span aware, unlike findArtifactSignatures — a fenced block does not
 * make a live credential safe. The escape hatch is structural instead: every pattern requires
 * a secret BODY, so writing about a prefix is always fine.
 */

import {
  CREDENTIAL_SIGNATURES,
  CREDENTIAL_PLACEHOLDER_PATTERN,
} from '../config/credentialDetectionConfig.js';
import { scanStringsDeep, type DeepStringScan } from './inputHygiene.js';

/**
 * Return the ids of the credential shapes found in `value`, in vocabulary order. Empty array
 * → clean. Never returns the matched text (see the module header).
 *
 * A signature declaring `placeholderGroup` is skipped when that capture group is a
 * SCREAMING_SNAKE placeholder / env-var name — that is what keeps
 * `Authorization: Bearer MCP_AUTH_TOKEN` storable while a real token value is not. A
 * signature may add its own `extraPlaceholderPattern` (the assignment-shaped ones do, to
 * admit `your_password_here`); it is tested IN ADDITION to the shared pattern, never instead.
 */
export function findCredentialSignatures(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const found: string[] = [];
  for (const sig of CREDENTIAL_SIGNATURES) {
    const match = sig.pattern.exec(value);
    if (!match) continue;
    if (sig.placeholderGroup !== undefined) {
      const body = match[sig.placeholderGroup];
      if (body !== undefined && CREDENTIAL_PLACEHOLDER_PATTERN.test(body)) continue;
      if (body !== undefined && sig.extraPlaceholderPattern?.test(body)) continue;
    }
    found.push(sig.id);
  }
  return found;
}

/** True when `value` contains a structurally-identifiable credential. */
export function hasCredentialSignature(value: unknown): boolean {
  return findCredentialSignatures(value).length > 0;
}

/**
 * Human phrases for a set of signature ids, for a rejection message. Ids not in the
 * vocabulary (only reachable if the vocabulary changed under us) fall back to the id itself
 * rather than being dropped — a finding must never become invisible on its way to the caller.
 */
export function describeCredentialSignatures(ids: readonly string[]): string {
  return ids
    .map((id) => CREDENTIAL_SIGNATURES.find((s) => s.id === id)?.label ?? id)
    .join(', ');
}

/**
 * Walk an arbitrary JSON-shaped value (a `metadata` bag) and report every string leaf holding
 * a credential, with the path it sits at. Shares the ONE bounded walker with the tool-XML
 * subtree scan, so both have identical depth/node bounds and an identical `truncated` meaning:
 * TRUE means part of the bag was never looked at, which is "could not measure", not "clean"
 * (CLASSES.md C1).
 */
export function findCredentialSignaturesDeep(root: unknown): DeepStringScan {
  return scanStringsDeep(root, findCredentialSignatures);
}
