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
- Reproducible customer guide and presentation generation, including native speaker notes and PDF previews.
- Versioned v1 customer release packaging with source commit, permission manifest, safe-default feature posture, per-file SHA-256 checksums, and an archive checksum.
- Fail-closed, GET-only read-only pilot validation with sanitized acceptance evidence.
- Unified JSON-backed customer wizard and preflight entry point.
- Selected-feature Microsoft 365 SKU checks and customer group-to-app-role assignment.
- Key Vault-backed Easy Auth credential rotation with post-rotation validation.
- Log Analytics retention/cap/sampling, alerts, monthly budget, and optional private endpoints/DNS.
- Plan-first uninstall, checksummed rollback, manifest/checksum backup and restore, and scale profiles.
- PR validation, environment-approved OIDC deployment, semantic releases, checksums, and provenance attestations.
- Certificate-backed unattended SharePoint evidence export with explicit tenant-wide consent.
- Feature-specific live readiness checks, constrained Mail.Send setup, and freshness-governed Teams activity, Purview lifecycle, Copilot usage, and agent evidence imports.
- Same-tenant disposable deployment state isolation and a guarded deploy/rollback/uninstall/reinstall/restore exercise runner.

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

- Validate the unified entry point and Key Vault migration against a fresh customer-like subscription before declaring general availability. The guarded exercise is implemented; a second enabled subscription is still required for destructive execution.
- Add Azure Monitor alerts for stale collector sources and permission drift after enough production telemetry exists to set defensible thresholds.
- Exercise the guarded uninstall/rollback runner in a disposable Azure subscription; local state isolation, plans, checksums, backup/restore, and emulator paths are tested today.
- Package module/tool prerequisites with version checks and installation guidance for Azure CLI, Node.js, Graph PowerShell, and SharePoint Online PowerShell.
- Extend the v1 release manifest with post-deployment resource outputs. Version, source commit, default feature posture, permission documentation, checksums, and sanitized pilot evidence are included today.
- Decide whether each customer accepts SharePoint `Sites.FullControl.All` for unattended tenant administration; otherwise retain the documented delegated administrator export.

### P1: production hardening

- Add resource locks and optional premium/zone-resilient compute tiers; diagnostic settings, policy tags, GRS/GZRS storage, and private networking are parameterized today.
- Add feature-by-feature consent bundles so enabling Copilot, usage reports, OneDrive review, provisioning, notifications, sharing revocation, or lifecycle execution grants only the required permissions.
- Add post-deployment cost-budget creation and a 7/30-day actual-cost report.
- Expand the GET-only pilot acceptance report with explicit collection-completeness, freshness, and unsupported-API assertions. Authentication, role enforcement, route health, dry-run settings, and identifier sanitization are covered today.

### P2: scale and operations

- Run department and enterprise profiles with representative customer-sized data; the harness and acceptance thresholds are implemented, and the read-only pilot profile is the first gate.
- Validate customer-specific RPO/RTO by quarterly isolated restore exercises; scripts and recommended objectives are documented.
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
- Machine-readable release manifest and per-file checksums.
- Sanitized GET-only pilot acceptance output.
- Customer guide, presentation, speaker notes, and PDF previews.
- Architecture and data-flow diagram.
- Parameter schema and worked GCC High example without tenant secrets.
- Permission manifest by feature.
- Components and cost model.
- Installation, validation, upgrade, rollback, and uninstall runbooks.
- Security model and threat/risk decisions.
- Data inventory, retention, and telemetry configuration.
- Acceptance-test output and known limitations.
- Support and ownership contacts.
