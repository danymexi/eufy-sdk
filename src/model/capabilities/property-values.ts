import type { Capability, PropertySpec } from "../types.js";
import { getCapabilityModule } from "./index.js";
import { borrowedBy, propertiesOf, readMemberValue, scalarSpec, type MemberDeps, type ValueMember } from "./members.js";
import type { AvailabilityContext } from "./types.js";

/** Find the owning member using the same capability precedence as property merging. @internal */
function propertyMember(capabilities: readonly Capability[], spec: PropertySpec, ctx: AvailabilityContext) {
  for (const cap of capabilities) {
    const members = getCapabilityModule(cap)?.members;
    if (!members || !propertiesOf(members, ctx).some((p) => p.name === spec.name && p.paramType === spec.paramType))
      continue;
    for (const [name, m] of Object.entries(members)) {
      if ("type" in m && (m.property ?? name) === spec.name) return { name, member: m as ValueMember, members };
    }
  }
  return undefined;
}

/** Project a parameter schema through its owning member's typed read contract. @internal */
export function scalarPropertySpec(
  capabilities: readonly Capability[],
  spec: PropertySpec,
  ctx: AvailabilityContext,
): PropertySpec {
  const entry = propertyMember(capabilities, spec, ctx);
  return entry ? scalarSpec(spec, entry.member) : { ...spec, unexposed: true };
}

/** Read a declared member from cached state, without invoking any freshness policy. @internal */
export function scalarPropertyValue(
  capabilities: readonly Capability[],
  spec: PropertySpec,
  deps: Pick<MemberDeps, "read" | "rawDp"> & { ctx: AvailabilityContext },
): boolean | number | string | undefined {
  const entry = propertyMember(capabilities, spec, deps.ctx);
  if (!entry) return undefined;
  const { member } = entry;
  if (member.unexposed || member.writeOnly || (member.available && !member.available(deps.ctx))) return undefined;
  const property = member.property ?? entry.name;
  const borrowed = borrowedBy(member, entry.members)?.property;
  if (deps.read(property)?.value === undefined && (borrowed === undefined || deps.read(borrowed)?.value === undefined))
    return undefined;
  const value = readMemberValue(entry.name, member, entry.members, deps.read, deps.ctx, deps.rawDp);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}
