import { orgRole } from "../db/schema/enums.ts";

export type OrgRole = (typeof orgRole.enumValues)[number];

export const ORG_ROLES = orgRole.enumValues;

/**
 * Seniority ordering, used for "cannot modify someone above you" checks.
 * Higher number = more authority.
 */
const RANK: Record<OrgRole, number> = {
  owner: 100,
  partner: 80,
  associate: 60,
  paralegal: 40,
  accountant: 40,
  assistant: 20,
};

export function outranks(actor: OrgRole, target: OrgRole): boolean {
  return RANK[actor] > RANK[target];
}

export function atLeast(actor: OrgRole, minimum: OrgRole): boolean {
  return RANK[actor] >= RANK[minimum];
}
