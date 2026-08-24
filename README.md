# Copilot Readiness Tracker

A self-contained program tracker for SharePoint and Teams cleanup, governance automation, and Microsoft 365 Copilot readiness.

## Use the tracker

Open the published site, then use either view:

- **Overview** summarizes completion, blockers, overdue work, ownership, phase health, and the Copilot rollout gate.
- **Detailed tracker** captures status, owner, target date, and notes for all 42 tasks across five phases.

Tracker data is saved in the current browser. Use **Backup JSON** and **Restore JSON** to move or protect local state. **Export CSV** and **Print report** support status reporting.

## Shared Microsoft Lists sync

Cloud sync is optional. It requires a Microsoft Entra single-page application registration and access to a SharePoint site. See [CLOUD-SYNC-SETUP.md](CLOUD-SYNC-SETUP.md) for the one-time setup and required delegated permissions.

No tenant IDs, client IDs, access tokens, passwords, or SharePoint URLs are committed in this repository.
