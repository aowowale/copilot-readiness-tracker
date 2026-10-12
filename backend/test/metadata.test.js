import test from "node:test";
import assert from "node:assert/strict";
import { metadataFromStep } from "../src/lib/metadata.js";

const actor = { id: "o1", name: "Owner" };
const now = new Date("2026-03-01T00:00:00Z");

test("contacts and metadata steps update the workspace register; other steps do not", () => {
  const contacts = metadataFromStep("contacts", { primary: "Ada", secondary: "Bo" }, actor, now);
  assert.equal(contacts.primaryContact, "Ada");
  assert.equal(contacts.secondaryContact, "Bo");
  assert.equal(contacts.updatedBy, "o1");
  assert.equal("description" in contacts, false);

  const purpose = metadataFromStep("metadata", { description: "Finance team", businessPurpose: "Close the books" }, actor, now);
  assert.equal(purpose.businessPurpose, "Close the books");
  assert.equal("primaryContact" in purpose, false);

  assert.equal(metadataFromStep("membership", { reviewed: true }, actor, now), null);
  assert.equal(metadataFromStep("links", { reviewed: true }, actor, now), null);
});
