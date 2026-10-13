# Customer deployment and tenant connection

This guide describes the production path for installing the dashboard in a customer's GCC High environment. The repository includes an Azure Functions backend, storage, authenticated UI, and an installer. A browser-only `file://` open uses sanitized sample data; the tenant deployment is not proven until the installer and live reads are validated in the target tenant.

Use [docs/COST-AND-COMPONENTS.md](docs/COST-AND-COMPONENTS.md) for the current cost model and [docs/PUSH-BUTTON-READINESS.md](docs/PUSH-BUTTON-READINESS.md) for the remaining customer-handoff work.

## Build the customer release

Generate the versioned source, documentation, permission manifest, checksums, and sanitized pilot evidence from the repository root:

```powershell
.\scripts\New-CustomerRelease.ps1 -Version 1.0.0
```

The command writes `artifacts/m365-copilot-readiness-v1.0.0.zip` and a companion `.zip.sha256` file. Verify the companion hash before extracting the archive. The package excludes install state, Azure CLI profiles, local settings, credentials, dependencies, and live tenant identifiers. Its default deployment posture is read-only and dry-run.

## Recommended architecture

Deploy the solution into a customer-owned Azure Government subscription:

```mermaid
flowchart LR
    User[Authorized governance user] -->|Entra sign-in| Web[Azure App Service]
    Web --> API[Protected governance API]
    API --> Store[(Customer-owned data store)]
    Timer[Scheduled collector] -->|Managed identity| Graph[Microsoft Graph GCC High]
    Timer -->|Managed identity or certificate| SPO[SharePoint Online admin]
    Import[Approved activity report import] --> Store
    Graph --> Timer
    SPO --> Timer
    Timer --> Store
```

- **Azure App Service** serves the dashboard and its protected API.
- **A scheduled collector** runs daily and writes normalized snapshots. Azure Functions is suitable when it is available in the customer's approved Azure Government region; otherwise use an App Service WebJob or approved automation host.
- **Customer-owned storage** holds only the fields needed by the dashboard. Azure Storage is sufficient for a small deployment; Azure SQL is appropriate when the customer requires relational reporting and longer history.
- **Microsoft Entra authentication** restricts the web app to an approved customer governance group.
- **Read identities are separate from user access.** Browser code never receives an application credential or tenant-wide Graph token.
- **Microsoft 365 remediation is not part of the first deployment.** The API can transition internal governance cases with role separation and audit evidence, but it cannot modify tenant resources. Any future tenant write action needs a separate execute identity, approval workflow, dry run, policy checks, and independent verification.

Use GCC High endpoints throughout:

| Service | Endpoint |
| --- | --- |
| Azure portal | `https://portal.azure.us` |
| Entra authority | `https://login.microsoftonline.us/{tenant-id}` |
| Microsoft Graph | `https://graph.microsoft.us/v1.0` |
| Azure management | `https://management.usgovcloudapi.net/` |
| SharePoint | The customer's `*.sharepoint.us` tenant URLs |

Do not substitute commercial `.com` endpoints in application configuration.

## Customer prerequisites

Before deployment, obtain written confirmation of:

- An Azure Government subscription, approved region, resource group owner, naming convention, and tags.
- The customer's tenant ID, primary domain, and SharePoint admin-center URL. These are identifiers, not secrets.
- An Entra administrator who can create app registrations, grant application consent, and assign access to the dashboard.
- A SharePoint Administrator who can validate site inventory and Restricted Content Discovery reporting.
- An approved data service: Azure Storage, Azure SQL, Cosmos DB, or another customer standard.
- The customer security group's decision on public App Service ingress with Entra authentication versus private networking.
- Retention, logging, monitoring, and deployment-pipeline requirements.
- The Team-level activity source actually available in that GCC High tenant.

If Conditional Access requires a secure AVD, perform the portal, Azure CLI, Graph, and SharePoint administration work from that AVD.

## Identity design

Use at least two security principals:

1. **Dashboard sign-in app**: authenticates users to the web application/API. It has no tenant inventory application permissions. Access is assigned only to a customer-managed governance group.
2. **Read-only collector identity**: a managed identity is preferred when the chosen SharePoint tooling supports it. Otherwise use a certificate credential stored in customer-controlled Key Vault. Do not use a client secret for the production collector.

Define these app-role values on the dashboard/API app registration and assign them through customer-managed Entra groups:

| App-role value | Purpose |
| --- | --- |
| `Governance.Reader` | Tenant-wide workspace and case visibility without workflow mutation |
| `Workspace.Owner` | Reserved for object-scoped owner tasks; it does not grant tenant-wide API reads |
| `Governance.Operator` | Triage, assign, request owner or approval action, cancel, and reopen expired exceptions |
| `Approver` | Approve or reject requests and grant governed exceptions |
| `Executor` | Move approved cases through execution, failure or retry, verification, and closure |
| `Auditor` | Read tenant-wide cases and evidence without workflow mutation |

Use stable role **values** exactly as shown because the API authorizes against the token's `roles` claim. Enable **Assignment required** on the enterprise application. Keep approver and executor group membership separate where customer policy requires separation of duties.

For stricter separation, give the SharePoint/RCD collector its own managed identity because SharePoint administration can require a broader role than Graph inventory.

Start with only the application permissions required by the pilot queries. The expected Graph permission set must be reviewed against the exact endpoints before consent, but typically includes read access for groups, Teams, Team members, channels, channel members, and channel file locations. Candidate permissions include:

- `Group.Read.All`
- `Team.ReadBasic.All`
- `TeamMember.Read.All`
- `Channel.ReadBasic.All`
- `ChannelMember.Read.All`
- `Files.Read.All` or `Sites.Read.All` when resolving channel file locations

Some endpoints offer resource-specific consent permissions, but those require per-Team installation or consent and may not fit a tenant-wide inventory. Do not grant write permissions or `Directory.ReadWrite.All` for the read-only release.

The SharePoint Online Management Shell supports unattended connections using managed identity or an application certificate. For GCC High, use the customer's `*.sharepoint.us` admin URL and `-Region ITAR`. The customer administrator must approve the identity and the minimum SharePoint role/permissions needed for the selected inventory and RCD cmdlets.

## Installation sequence

### Scripted install (any tenant, commercial or Azure Government)

Steps 2 to 5 below are automated by `scripts/Install-Governance.ps1`. It is safe to re-run.

```powershell
# 1. Which tenants can host a deployment? (offline, read-only)
.\scripts\Get-TenantInventory.ps1

# 2. Check everything first; changes nothing
.\scripts\Install-Governance.ps1 -TenantId <tenant> -SubscriptionId <sub> -Location <region> -PreflightOnly

# 3. Install (Azure Government: az cloud set --name AzureUSGovernment, then az login first)
.\scripts\Install-Governance.ps1 -TenantId <tenant> -SubscriptionId <sub> -Location <region>

# 4. Prove it works: every route, app roles, and one real collector run
.\scripts\Test-Deployment.ps1 -TenantId <tenant>
```

`Test-Deployment.ps1` obtains a delegated API token for the signed-in operator, verifies Easy Auth and every read route, checks the dashboard and missing-route behavior, and calls `POST /api/collector/run`. That endpoint requires `Governance.Operator`, runs the same read-only collector used by the timer, waits for completion, and writes only governance snapshots, findings, tasks, and run history to the deployment's own storage. It does not enable an executor identity or mutate Microsoft 365. Use `-SkipCollector` when validating only authentication, routes, and the dashboard.

Preflight checks the tools, the Azure cloud and sign-in, the subscription and its tenant, the region, your Azure roles (Contributor plus the ability to assign roles), and your Entra roles (create app registrations, grant Graph permissions). It stops before changing anything if a check fails. To keep another window's subscription untouched, run it in an isolated profile: `$env:AZURE_CONFIG_DIR = "$HOME\.azure-<name>"`.

The installer needs both an Azure subscription and a tenant administrator. If different people hold those, run it with `-SkipGraphGrants` and have a Global Administrator grant the Graph permissions it prints. It grants the collector identity read-only application permissions only: `Group.Read.All`, `Team.ReadBasic.All`, `TeamMember.Read.All`, `Channel.ReadBasic.All` and `User.Read.All` (manager lookup), plus `Reports.Read.All` with `-IncludeUsageReports`. It assigns the installing user `Governance.Reader` and `Governance.Operator`; assign `Approver`, `Executor` and `Workspace.Owner` to the right people in Entra.

The dashboard page and the API are served from the same function app, so one sign-in protects both. `AzureWebJobsDisableHomepage=true` lets the dashboard own `/`, while its explicit root-only route cannot intercept `/api/*`. The sign-in client secret is stored as an app setting; rotate it before its one-year expiry (rerun the installer).

If Entra sign-in reaches `/.auth/login/aad/callback` but returns `401`, run `Test-Deployment.ps1 -TenantId <tenant> -SkipCollector`. A failed **Easy Auth client secret is configured** check means the app setting was removed or is empty; rerun the installer to rotate and restore it. If the check passes, sign out through `https://<app-host>/.auth/logout`, then sign in with an account assigned a governance app role in the deployment tenant.

Notifications are recorded but not sent by default (`-NotificationMode dry-run`). To send reminders and escalations by email, add `-EnableExecution -NotificationMode live -NotificationSender <mailbox> [-NotificationOperatorEmail <team mailbox>]`. That grants the executor identity `Mail.Send`, which allows sending as any mailbox until you restrict it: create an Exchange Online application access policy limiting the executor to the sender mailbox. The installer prints this reminder, and sets `APP_URL` so messages link back to the dashboard.

### 1. Validate the tenant before building

Run a short proof of access against a customer-approved pilot containing a standard channel, private channel, shared channel, guest, and known SharePoint exposure condition.

Validate that the proposed identity can read:

- Microsoft 365 Groups that are provisioned as Teams.
- Team properties, owners, members, guests, and archive state.
- Standard, private, and shared channel inventory and direct membership.
- Each channel's file location and associated SharePoint site.
- SharePoint site sharing/exposure fields needed for the agreed risk rules.
- Restricted Content Discovery status and report output, if licensed and enabled.

This proof is the permission gate. Remove any permission that is not exercised, and document any field that cannot be obtained in the customer's cloud.

### 2. Create customer-owned Azure resources

In `https://portal.azure.us`, create or select:

- Resource group.
- App Service plan and web app for the dashboard/API.
- Function App, WebJob, or approved scheduler for collection.
- Storage account or approved database.
- Key Vault only when certificate material or other secrets are required.
- Application Insights and Log Analytics, subject to customer policy.

Use managed identities, HTTPS-only access, TLS 1.2 or later, diagnostic logs, resource locks where required, and the customer's standard private endpoint/network controls.

### 3. Configure dashboard authentication

Create a single-tenant Entra app registration for dashboard/API sign-in, expose an API Application ID URI such as `api://<client-id>`, and add the app roles above. Supply its client ID as the required `apiClientId` Bicep parameter. The template configures App Service Authentication against the GCC High issuer, restricts the accepted audience, requires HTTPS, and returns `401` for unauthenticated requests. Set **Assignment required** on the enterprise application and assign only approved role groups.

App Service Authentication validates the token issuer, tenant, audience, and expiration. The API separately validates app roles for every route. Do not rely on hidden navigation or frontend checks for authorization.

### 4. Configure the collector identity

Enable a managed identity on the collector host. A customer Entra administrator grants the reviewed Microsoft Graph application permissions and admin consent. If the SharePoint module or customer policy requires certificate authentication instead, upload the public certificate to the app registration and store the private certificate in customer-controlled Key Vault.

Never place a token, client secret, PFX file, or private certificate in this repository, browser storage, App Service source files, chat, or email.

### 5. Deploy the API and normalized store

The collector should write snapshots rather than expose Graph directly to the browser. At minimum, store:

- Workspace and Team IDs, display name, archive state, and classification fields.
- Owners, member and guest counts, and channel counts.
- Private/shared channel membership indicators needed for governance review.
- Parent Team site and private/shared channel site identifiers and URLs.
- Agreed SharePoint exposure and RCD fields.
- Activity bucket, source, source timestamp, and collection timestamp.
- Collector run status, partial failures, and data-quality warnings.

Return `Unknown` when a source is missing, stale, unsupported, or failed. Never translate missing activity into `Inactive`.

Expose `GET /api/workspaces` and replace the hardcoded `governanceWorkspaces` array in `index.html` with that response. Keep a clearly labeled sample-data fallback only for demonstration mode.

The initial policy layer exposes:

- `GET /api/findings`, with optional `status`, `policyId`, `resourceId`, and `limit` filters.
- `GET /api/policies`, containing the active versioned policy catalog.

The `workspace-health-v1` pack checks for at least two owners and whether approved activity and SharePoint exposure evidence is available. It keeps missing evidence explicit as `unknown`. Ownership findings generate stable internal cases in `detected`, dry-run state; repeated collections do not replace a case that an operator has already progressed. Resolved findings remain available as evidence. No policy in this pack changes a Team, site, owner, member, sharing setting, or lifecycle state.

The case workflow also exposes:

- `GET /api/cases`
- `GET /api/cases/{caseId}`
- `GET /api/exceptions`
- `POST /api/cases/{caseId}/transition`

A transition request includes the caller's last observed version so stale browser sessions cannot overwrite another decision:

```json
{
    "transition": "triage",
    "expectedVersion": 0,
    "reason": "Source evidence validated"
}
```

The response contains the updated case and its audit event. A stale version or invalid lifecycle jump returns `409`. The case update and transition evidence are committed atomically in the current Azure Tables pilot store.

The published UI includes a Findings queue with evidence and case-history detail, plus second-approver reviews for archive and delete decisions. An Executor may separately simulate or execute an approved lifecycle action. Live mode requires the explicit `ENABLE_LIFECYCLE_EXECUTION` flag, `EXECUTION_MODE=live`, and the separate executor identity. The user must type the workspace-specific confirmation. Deletion requires a fresh evidence feed with both `legalHold=false` and `retentionLocked=false`. Archive is verified through `isArchived`; delete is verified as Microsoft 365 group soft-delete, not a content purge. Inconclusive Graph results are marked uncertain and require manual reconciliation, never blind retry.

OneDrive review starts from `Export-WorkspaceEvidence.ps1 -IncludeOneDrive`, which supplies personal-site owner, last-content-activity, storage, sharing-capability and site-state metadata. The UI lets the owner or a Governance.Operator record retain, owner-follow-up or escalate. The owner may request a bounded scan (100 items, 3 folder levels) of item names and permission metadata (no file contents), then propose selected link/direct-grant removals. The server resolves the owner and drive, blocks the owner's own permission, requires the reviewer not be the target, re-reads every selected permission before execution, and verifies after. Stale exports disable the flow, truncated scans are labeled, and dry-run is default. `-EnableOneDriveSharingReview` grants collector `Sites.Read.All`; live removal also needs `-EnableExecution -EnableLinkRevocation -ExecutionMode live`. This is not a tenant-wide complete file scan; it is a bounded action review.

Provisioning can apply sensitivity labels when the customer supplies the verified mapping from catalog display names to label GUIDs: `-EnableSensitivityLabels -SensitivityLabelIdsJson '{"Internal":"<guid>","Confidential":"<guid>"}'`. The installer validates the map and grants executor `Group.ReadWrite.All`. Without a mapping, live provisioning fails before group creation. After create, the service applies the label and reads it back before declaring success. If readback fails, the group id is retained for manual reconciliation. Verify the exact catalog labels and Graph behavior in the tenant first.

Approvers can preview and set a versioned baseline per workspace (`GET /api/baselines`, `POST /api/baselines/preview`, `PUT /api/baselines/{workspaceId}`). The collector compares later snapshots, keeps Unknown separate, and opens deduplicated drift alerts. Operators can acknowledge alerts without resetting the baseline. Alert email uses the existing `NOTIFICATION_MODE`; no tenant state is reverted.

### 6. Add collection in stages

Use this order so each source can be reconciled independently:

1. Graph group, Team, owner, member, guest, and channel inventory.
2. Channel file-location correlation to parent and channel SharePoint sites.
3. SharePoint administration exposure fields.
4. Restricted Content Discovery status and report data.
5. Customer-approved Team-level activity source.

Microsoft Graph's standard Teams team-activity report API is not available in GCC High. Do not advertise daily activity until the customer validates a supported admin report, an approved audit-derived aggregate, or a controlled import. Display the selected source and its timestamp in the UI.

### 7. Reconcile the pilot

Compare dashboard output with Teams admin center, SharePoint admin center, and the approved activity source for the pilot. Record expected counts and investigate every mismatch before expanding scope.

Acceptance criteria:

- All pilot Teams appear exactly once.
- Owners, members, guests, and channels match authoritative admin views.
- Parent, private-channel, and shared-channel SharePoint sites correlate correctly.
- Missing or unsupported values display as `Unknown` with a reason.
- Repeated policy evaluation keeps stable finding and case IDs without duplicating cases.
- Missing activity or exposure evidence produces `unknown` data-quality findings, not healthy results.
- Correcting an ownership finding marks the finding resolved without automatically closing or overwriting its governance case.
- The API rejects unauthenticated users and users outside the approved group.
- Each role can perform only its documented transitions, and stale versions return `409` without changing the case.
- Every successful transition records actor, time, source and target status, reason, policy version, and correlation ID.
- Collector failures are logged and do not overwrite a good snapshot with empty data.
- The default collector is read-only and execution is dry-run. Optional live executor capabilities are separate and require explicit deployment settings. Executor paths cover member removal, selected Team/OneDrive item-sharing revocation, approved request provisioning and explicitly armed approved archive/delete decisions. The OneDrive export/scan is bounded, and site-level shadow access is not changed. Sensitivity-label application requires an explicit, tenant-verified mapping. No owner decision, baseline approval, case transition, OneDrive metadata review or drift acknowledgement silently mutates Microsoft 365.

### 8. Promote to production

After customer sign-off, expand collection to the full tenant, schedule daily runs, configure failure alerts, set retention, document identity/certificate rotation, and hand over an operations runbook. Record source-specific refresh timestamps because a daily collector does not make every upstream source real time.

## What the customer must do

The customer retains control of the subscription, app registrations, admin consent, governance-group membership, data store, monitoring, and credentials. The implementation team can deploy code and infrastructure under delegated access, but the customer's authorized administrators should perform or approve all consent and role assignments.

## Decisions needed to start

Provide these four answers before creating deployable infrastructure:

1. Which customer Azure Government subscription and approved region will host the app?
2. Which storage service is approved: Azure Storage, Azure SQL, Cosmos DB, or another platform?
3. Can an Entra administrator grant application permissions and can a SharePoint Administrator support the pilot?
4. Which Team-level activity report or audit source is available and approved in the customer's GCC High tenant?
5. Which Entra groups will receive each governance app role, and which roles must remain separated?

The first production milestone should be a read-only pilot for 5-10 representative Teams, not a tenant-wide rollout.