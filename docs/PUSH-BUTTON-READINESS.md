# Push-button deployment readiness

The target experience is a customer-owned, parameter-driven deployment that performs preflight, deploys safely in dry-run mode, verifies itself, and leaves clear evidence and rollback instructions.

## What is automated today

- Azure/cloud/tenant/subscription/region and administrator preflight.
- Entra dashboard application, API scope, app roles, and service principal creation.
- Azure Government Bicep deployment for App Service plan, Function App, Storage, Application Insights, managed identities, tables, evidence container, and storage role assignments.
- Read-only Microsoft Graph application-permission grants for the collector.
- Optional, separate executor identity and feature-specific write permissions.
- Backend packaging and deployment.
- App Service Authentication configuration and dashboard publication.
- Installing-user Reader/Operator app-role assignments.
- End-to-end deployment smoke test, authenticated route checks, collector trigger, storage verification, and risk/task verification.
- Idempotent synthetic test-tenant seeding and prefixed cleanup.

## Required human gates

These should remain explicit even in a polished installer:

1. Select and verify cloud, tenant, subscription, region, naming, tags, and network model.
2. Review Graph and SharePoint permissions before administrator consent.
3. Select approved governance role groups and separation-of-duty owners.
4. Confirm retention, telemetry, activity-source, and evidence-source policy.
5. Keep execution in dry run until the customer approves each mutation family.
6. Perform SharePoint Online administrator authentication where delegated interactive tooling is required.
7. Approve live notification sender and restrict `Mail.Send` to that mailbox.
8. Supply verified sensitivity-label IDs and legal-hold/retention evidence sources before lifecycle execution.

“Push button” must not mean silent tenant-wide consent or automatic live remediation.

## Gaps before customer handoff

### P0: required

- Create one supported entry script or deployment package that generates a customer parameter file, runs preflight, displays the permission manifest, deploys, assigns customer-provided role groups, and runs validation.
- Add a deterministic prerequisite check for Microsoft 365 SKU/service plans used by selected features.
- Replace the generated dashboard client secret in plain app settings with an approved secret lifecycle, such as a Key Vault reference and rotation procedure, or another supported App Service Authentication credential design.
- Add explicit Log Analytics workspace, retention, sampling, daily cap, budget, and alerts to infrastructure parameters.
- Add a tested uninstall/rollback command for Azure resources, app registrations, service principals, role assignments, and optional seed data.
- Package module/tool prerequisites with version checks and installation guidance for Azure CLI, Node.js, Graph PowerShell, and SharePoint Online PowerShell.
- Add a deployment manifest containing versions, enabled features, granted permissions, outputs, and verification results without secrets.
- Resolve SharePoint automation authentication for customer environments: supported certificate/managed-identity path where possible, documented delegated admin fallback otherwise.

### P1: production hardening

- Parameterize public ingress versus private networking and document DNS/private-endpoint requirements.
- Add resource locks, diagnostic settings, customer policy tags, and optional zone/resilience tiers.
- Add CI/CD with signed/reviewed artifacts, Bicep validation, backend tests, and environment approvals.
- Add app-role assignment for pre-existing customer groups during install rather than a separate seed pass.
- Add feature-by-feature consent bundles so enabling Copilot, usage reports, OneDrive review, provisioning, notifications, sharing revocation, or lifecycle execution grants only the required permissions.
- Add post-deployment cost-budget creation and a 7/30-day actual-cost report.
- Add a customer acceptance report covering authentication, role boundaries, collection completeness, data freshness, dry-run evidence, and unsupported cloud APIs.

### P2: scale and operations

- Load-test collection and API behavior at documented tenant-size bands.
- Define backup/restore and disaster-recovery objectives.
- Add operational dashboards and alerts for collector failure, stale sources, permission drift, storage errors, and executor uncertainty.
- Add upgrade/migration handling for storage schema, app roles, and permission changes.
- Publish support ownership, incident response, and release/compatibility policy.

## Recommended customer workflow

```text
Get package -> Fill parameter file -> Preflight -> Review permission manifest
-> Deploy dry-run -> Assign role groups -> Validate -> Pilot collection
-> Customer acceptance -> Enable approved write capabilities individually
```

The default package should stop after validated dry-run deployment. Live mutation must require a separate explicit command and customer approval record.

## Handoff artifacts

A customer-ready release should include:

- Versioned source package and checksum.
- Architecture and data-flow diagram.
- Parameter schema and worked GCC High example without tenant secrets.
- Permission manifest by feature.
- Components and cost model.
- Installation, validation, upgrade, rollback, and uninstall runbooks.
- Security model and threat/risk decisions.
- Data inventory, retention, and telemetry configuration.
- Acceptance-test output and known limitations.
- Support and ownership contacts.
