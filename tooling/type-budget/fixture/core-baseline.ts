/**
 * Baseline for the type-instantiation budget (#61): the cost of checking core itself plus one
 * trivial call. `core-stress.ts` minus this is the cost of the stress call sites alone, so core
 * growing new exports or a lib bump does not move the budgeted number.
 */
import { ok } from "@friday-friday/core"

export const o = ok(1)
