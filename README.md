# Microsoft 365 Copilot Readiness

A self-contained prototype for SharePoint and Teams governance, cleanup, and Microsoft 365 Copilot readiness.

For a literal pre-tenant preparation checklist, file inventory, and safe customer package instructions, begin with [START-HERE.md](START-HERE.md).

## Current implementation

Open the published site, then use one of three views:

- **Tenant governance** demonstrates the intended operational dashboard with clearly labeled sample data. It includes 30/60/90-day aging, owners, membership and guests, active-channel counts, SharePoint exposure indicators, RCD coverage, lifecycle status, filters, and workspace drill-down.
- **Program plan** summarizes completion, blockers, overdue work, ownership, phase health, and the Copilot rollout gate.
- **Program tasks** captures status, owner, target date, and notes for all 42 tasks across five phases.

The Tenant governance records are sample data, not findings from a Microsoft 365 tenant. The page displays this status prominently and does not offer tenant mutation or remediation controls.

Program-task data is saved in the current browser. Use **Backup JSON** and **Restore JSON** to move or protect local state. **Export CSV** and **Print report** support program reporting.

## Shared Microsoft Lists sync

Task sync is optional. It synchronizes only the 42 program tasks through Microsoft Lists; it does not collect Teams, channel, membership, activity, SharePoint exposure, or RCD data. It requires a Microsoft Entra single-page application registration and access to a SharePoint site. See [CLOUD-SYNC-SETUP.md](CLOUD-SYNC-SETUP.md) for the one-time setup and required delegated permissions.

## Planned tenant connection

The next implementation milestone is a read-only GCC High data pipeline and normalized API. It will run under a backend service identity, not privileged browser JavaScript, and will correlate:

- Microsoft 365 Groups, Teams, owners, members, and channel inventory from supported Microsoft Graph endpoints.
- Parent Team sites and the separate SharePoint sites used by private and shared channels.
- SharePoint administration and SharePoint Advanced Management/Data Access Governance findings.
- Restricted Content Discovery status and report data.
- A tenant-approved Team-level activity source with source and refresh timestamps.

Microsoft Graph's Teams team-activity report endpoint is not supported in GCC High. The activity connector must therefore be validated against a supported tenant report, an approved audit-derived aggregate, or a controlled report import before the dashboard can claim daily activity refresh.

Ownership/member changes, RCD changes, archive, and deletion remain out of this browser-only prototype. Those actions require a backend approval workflow, separate read and execute identities, policy checks, dry-run support, and audit history.

See [CUSTOMER-DEPLOYMENT.md](CUSTOMER-DEPLOYMENT.md) for the recommended Azure Government architecture, customer prerequisites, identity and permission model, pilot validation, and production installation sequence.

No tenant IDs, client IDs, access tokens, passwords, or SharePoint URLs are committed in this repository.
