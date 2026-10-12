// Workspace metadata register: the contacts and business purpose an owner confirms during the
// review become the workspace's record, so the next reviewer starts from them.

export function metadataFromStep(step, data, actor, now = new Date()) {
  let fields;
  if (step === "contacts") fields = { primaryContact: data?.primary ?? null, secondaryContact: data?.secondary ?? null };
  else if (step === "metadata") fields = { description: data?.description ?? null, businessPurpose: data?.businessPurpose ?? null };
  else return null;
  return { ...fields, updatedBy: actor.id, updatedByName: actor.name || null, updatedAt: new Date(now).toISOString() };
}
