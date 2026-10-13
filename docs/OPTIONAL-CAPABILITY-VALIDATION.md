# Optional capability validation

Optional capabilities are disabled by default and are certified independently. A successful read-only deployment does not imply approval for tenant mutation.

| Capability | Prerequisite | Synthetic live test | Required evidence |
| --- | --- | --- | --- |
| Notifications | Executor `Mail.Send`, approved mailbox, Exchange restriction | Send one assignment to a controlled recipient; prove an out-of-scope mailbox is denied | Policy allow/deny output, delivery record, dedupe record |
| Provisioning and labels | `Group.Create`, `Team.Create`, verified label GUIDs, two owners | Create a uniquely prefixed private Team | Group/Team ID, assigned label readback, owner readback, audit record |
| Archive | `TeamSettings.ReadWrite.All`, fresh no-hold evidence, independent actors | Archive a synthetic Team | Operation completion and `isArchived=true` readback |
| Delete | `Group.ReadWrite.All`, fresh no-hold/no-retention evidence, independent actors | Soft-delete a synthetic Team | Group GET returns 404 and deleted-item recovery record exists |
| Sharing revocation | Selected Sites/Files write permission | Revoke a synthetic organization link and non-member direct grant | Before/after permission inventory; protected owner/inherited/self tests |
| GCC High activity | Customer-approved Teams activity export | Merge known Team ID/date/channel values | Feed provenance, generated timestamp, collector source status |
| Copilot usage | Customer-approved Admin Center export in GCC High | Join a known licensed test user to usage | Export provenance, refresh date, adoption source status |
| Agents | Teams app catalog plus approved exports for unlisted platforms | Reconcile known test app/agent | Source list, ownership state, freshness |

Unknown or stale lifecycle evidence blocks archive/delete. Unmapped labels block provisioning before creation. Permission changes between preview and sharing execution block revocation.

Run `Test-OptionalCapabilities.ps1` before and after each capability change. Store its redacted JSON output with the customer approval record. Do not combine first-time certification of multiple mutation families in one change window.