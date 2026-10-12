# GCC High test deployment case study

Last updated: 2026-10-12

This case study records the reproducible setup of a disposable GCC High test tenant. Tenant identifiers are intentionally replaced with placeholders; credentials, access tokens, MFA codes, and user passwords are never recorded.

## Target

| Item | Value |
| --- | --- |
| Organization | Disposable test organization |
| Initial domain | `<tenant>.onmicrosoft.us` |
| Tenant ID | `<tenant-id>` |
| Azure subscription | Test Azure Government subscription |
| Subscription ID | `<subscription-id>` |
| Azure cloud | `AzureUSGovernment` |
| Deployment region | `usgovvirginia` |
| Isolated CLI profile | `$HOME\.azure-sam-gcch-test` |

## Verified prerequisites

`Install-Governance.ps1 -PreflightOnly` passed on 2026-10-12. It confirmed:

- Azure CLI, Node.js, and npm are installed.
- The subscription is enabled and belongs to the target tenant.
- `usgovvirginia` is available.
- The installing administrator can create Azure resources and assign Azure roles.
- Microsoft Graph GCC High is reachable.
- The administrator can create app registrations and grant Graph application permissions.
- Preflight exited before resource-provider registration or resource creation.

Pre-seed directory baseline: 2 users, 0 groups, 0 `samtest.*` users, and 0 `samtest-*` groups.

## Subscription inventory

| Graph `skuPartNumber` | Seats | Planned use |
| --- | ---: | --- |
| `SPE_E5_USGOV_GCCHIGH` | 25 | Assign to all 16 active seeded internal users/personas |
| `SharePoint_advanced_management_plan_1_USGOV_GCCHIGH` | 25 | Assign to all 16 active seeded internal users/personas |
| `M365_COPILOT_CUSTOM_DD_ONLY_GCCH_USGOV_GCCHIGH` | 5 | Assign to five interactive personas for adoption/idle-seat testing |
| `Power_Virtual_Agents_USGOV_GCCHIGH` | 25 | Assign to the Governance Operator persona for Copilot Studio agent testing |
| `EMSPREMIUM_USGOV_GCCHIGH` | 1 | Leave unassigned; `SPE_E5` already includes Entra ID P1/P2, Intune, and related EMS plans |

Guests and the deleted owner scenario receive no licenses. The five Copilot personas are Reader, Operator, Approver, Executor, and Workspace Owner. Auditor intentionally remains without Copilot for entitlement-boundary comparison.

## Change log

| Time (UTC) | Action | Result |
| --- | --- | --- |
| 2026-10-12 | Isolated Azure CLI login | Verified `AzureUSGovernment`, target tenant, subscription, and administrator |
| 2026-10-12 | Read-only Graph subscription inventory | Five enabled subscriptions found; Copilot capacity confirmed at five seats |
| 2026-10-12 | Installer preflight | Passed; no changes made |
| 2026-10-12 | Pre-seed directory inventory | Clean baseline confirmed |
| 2026-10-12 | Initial seed attempt | Authentication expired before connection; no changes made |
| 2026-10-12 | Seed resume | Created 16 active users, 6 governance groups, and 8 Teams; deleted the departed-owner account after Team creation |
| 2026-10-12 | Base license assignment | Assigned E5 and SharePoint Advanced Management to all 16 active seeded accounts |
| 2026-10-12 | Copilot assignment | Assigned all 5 seats to Reader, Operator, Approver, Executor, and Workspace Owner |
| 2026-10-12 | Copilot Studio check | Graph confirmed the tenant-capacity SKU cannot be assigned to a user; no per-user assignment required |
| 2026-10-12 | Seed verification | Verified 16 enabled users, 8 unified Teams, 6 governance groups, 16 E5/SAM assignments, and 5 Copilot assignments |
| 2026-10-12 | SharePoint agent login | WAM and system-browser authentication failed in the agent-hosted terminal; no SharePoint change occurred |
| 2026-10-12 | SharePoint administrator run | Requested personal sites for all 16 active users and started five Data Access Governance reports |
| 2026-10-12 | Shadow-access seed | Added Patti, Johanna, and Megan to the intended Team-site Visitors groups; removed both temporary site-admin elevations |
| 2026-10-12 | OneDrive isolation repair | Stopped an overly broad rerun, removed the recreated departed account, and changed `-SeedOneDriveContent` to bypass all base user and Team mutations |
| 2026-10-12 | Ownerless-state verification | Confirmed the departed account is absent and SAMTest Legacy Intranet WG has zero owners |
| 2026-10-12 | Interactive OneDrive attempt | Graph consent completed, but all three personal-drive requests returned `Forbidden` because delegated file permission does not give the administrator site-level access automatically |
| 2026-10-12 | OneDrive access repair | Added an opt-in path that temporarily elevates `<administrator-upn>` on only the three target personal sites and always removes elevation in `finally` |
| 2026-10-12 | OneDrive authentication retry | WAM reported a canceled authentication before any mutation; corrected the Graph splat to use the supported `UseDeviceCode` parameter and made device code automatic for this flow |
| 2026-10-12 | SharePoint authentication retry | Graph device-code login succeeded, then SharePoint WAM native interop failed before elevation; changed both SharePoint seed paths to modern authentication with an explicit system browser |
| 2026-10-12 | OneDrive content seed | Uploaded the Alex, Adele, and Patti test files after narrowly elevating the administrator on their personal sites; removed all three elevations afterward |
| 2026-10-12 | Post-OneDrive verification | Confirmed the departed account remains absent and SAMTest Legacy Intranet WG remains ownerless |

## Seed results and exceptions

- Finance contains the default General channel plus standard, private, and shared test channels.
- Graph requires shared channels to be created with one owner and additional members added afterward. The seed now follows that sequence and re-queries asynchronous channel creation for the ID.
- The current Azure CLI Graph token lacks `ChannelMember.ReadWrite.All`, so the shared channel exists with Megan as owner but Johanna's direct membership remains pending. Future interactive channel seeding requests this scope explicitly.
- Guest invitations remain blocked by the tenant's external-collaboration policy. The script temporarily requested `adminsAndGuestInviters`, received `Forbidden`, and restored the original `none` setting.
- Anonymous links remain blocked by tenant policy. This is a valid secure posture, but it means anonymous-link findings need controlled imported evidence or a separately approved test policy change.
- Direct file grants and the organization-wide link scenarios succeeded.
- The Legacy Intranet Team became ownerless when the temporary departed owner was deleted.
- Governance persona passwords were generated but never disclosed or stored. The tenant administrator must reset the six persona passwords before interactive role testing.
- Personal-site provisioning was requested for all 16 active users. OneDrive content seeding is complete for Alex (`SAMTest-Budget.txt`), Adele (`SAMTest-HR-Plan.txt`), and Patti (`SAMTest-Facilities.txt`). The administrator was temporarily elevated only on those three personal sites, and all three elevations were removed successfully.
- Shadow-site access is complete: Patti was added to FY24 Acquisition Visitors, and Johanna and Megan were added to Vendor Collaboration Visitors. Temporary site-admin elevation was removed afterward.
- Five Data Access Governance reports were started: Anyone links, organization links, guest links, Everyone Except External Users, and permissioned users.

Current subscription consumption after seeding:

| Subscription | Consumed / enabled |
| --- | ---: |
| E5 | 16 / 25 |
| SharePoint Advanced Management | 16 / 25 |
| Microsoft 365 Copilot | 5 / 5 |
| Copilot Studio tenant capacity | 0 / 25 user assignments (not user-assignable) |
| Standalone EMS E5 | 0 / 1 |

## Planned sequence

1. Create ordinary workspace users and six interactive governance personas.
2. Assign E5 and SharePoint Advanced Management to all 16 active internal accounts.
3. Create governance role groups, eight Teams, standard/private/shared channels, guests, files, links, and owner-risk scenarios.
4. Assign five Copilot seats and one Copilot Studio seat to designated interactive personas.
5. Provision OneDrive personal sites, then seed representative OneDrive sharing scenarios.
6. Verify directory objects, licenses, Teams/channels, and cleanup boundaries.
7. Deploy Azure resources in dry-run execution mode and validate every API route and collector.

## Security and handoff principles

- Every tenant is accessed through its own `AZURE_CONFIG_DIR`.
- Passwords are entered only into hidden local PowerShell prompts.
- The collector identity remains read-only; tenant write actions use a separate executor identity.
- Dry run is the default for all remediations.
- Every seeded object uses a recognizable `samtest` prefix and is removable by the cleanup command.
- Customer handoff must replace test identifiers with parameters and preserve preflight, explicit consent, dry-run defaults, verification, and rollback instructions.
