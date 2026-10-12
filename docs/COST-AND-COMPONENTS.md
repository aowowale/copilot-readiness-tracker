# Components and cost model

Last priced: 2026-10-12. Currency: USD. Region: Azure US Gov Virginia.

This is an engineering estimate, not a quote. Azure retail rates can change and customer agreements, reservations, taxes, support, data transfer, and Microsoft 365 government licensing can change the effective price. Re-run the Azure Retail Prices API query and obtain a licensing-partner quote before each customer proposal.

## Deployed Azure components

| Component | Purpose | Billing behavior |
| --- | --- | --- |
| Linux App Service plan | Runs the Node.js Azure Function continuously; Always On supports the scheduled collector | Fixed hourly charge by plan tier |
| Azure Function App | Serves the authenticated dashboard/API and runs collection | Uses the App Service plan; no separate consumption charge in this design |
| StorageV2 account, Standard LRS | Azure Tables store governance state; Blob container stores approved evidence feeds; Functions also uses storage host services | Capacity and transaction charges |
| Application Insights | Request, dependency, exception, and application telemetry | Log ingestion and retention charges; no fixed component charge assumed |
| Collector managed identity | Read-only Microsoft Graph and storage access | No direct charge |
| Optional executor managed identity | Separately consented write operations when execution is enabled | No direct charge |
| Entra app registration and enterprise application | Dashboard sign-in, API audience, scopes, and app roles | No direct Azure resource charge; Entra licensing is separate |
| Azure role assignments | Managed-identity access to Tables, Blobs, and Queues | No direct charge |

The Bicep template does not currently deploy Key Vault, private endpoints, Azure Firewall, Front Door, backup vaults, or an explicit Log Analytics workspace. Customer policy may require these, and they must be estimated separately.

## Current Azure retail inputs

Public Azure Retail Prices API results for `usgovvirginia`:

| Meter | Retail rate |
| --- | ---: |
| Linux App Service B1 | $0.0316/hour, approximately **$23.07/month** at 730 hours |
| Linux App Service P0v3 | $0.0925/hour, approximately **$67.53/month** at 730 hours |
| Linux App Service S1 | $0.138/hour, approximately **$100.74/month** at 730 hours |
| Table LRS data stored | $0.0562/GB-month |
| Table reads/writes/scans/lists/deletes | $0.00045 per 10,000 operations |
| Log Analytics analytics-log ingestion | Up to $2.88/GB before applicable free benefits or commitments |
| Log Analytics extended retention | $0.13/GB-month where charged |

P0v3 and S1 are comparison points, not automatic recommendations. Confirm tier availability and required features such as deployment slots, scale, private endpoints, and SLA in the customer's approved region.

## Pilot estimate

A small tenant with daily collection, low dashboard traffic, less than 1 GB of stored governance data, and controlled telemetry should be approximately:

| Cost area | Monthly estimate |
| --- | ---: |
| B1 compute | $23.07 |
| Table/Blob capacity and operations | Less than $1 at pilot scale |
| Telemetry at 0.5 GB/month | Up to $1.44 before free benefits |
| **Illustrative Azure total** | **About $24-$26/month** |

Telemetry sensitivity:

- 2 GB/month at the retail ingestion rate adds up to $5.76.
- 5 GB/month adds up to $14.40.
- A noisy application can make telemetry the largest variable cost, so production deployment should set sampling, daily caps, retention, and alerts.

A practical Azure planning range is **$25-$40/month for a small B1 pilot**, excluding Microsoft 365 licenses and optional network/security services. P0v3 changes the base planning range to roughly **$70-$85/month** before optional services.

## Microsoft 365 licensing model

Microsoft 365 government prices are customer- and agreement-specific, so this repository does not hardcode dollar amounts. Estimate licensing with:

$$
C_{M365} = N_{E5}P_{E5} + N_{SAM}P_{SAM} + N_{Copilot}P_{Copilot} + N_{Studio}P_{Studio}
$$

For the comprehensive disposable test population:

| Entitlement | Quantity used |
| --- | ---: |
| Microsoft 365 E5 GCC High | 16 users |
| SharePoint Advanced Management | 16 users |
| Microsoft 365 Copilot GCC High | 5 users |
| Copilot Studio | Tenant capacity entitlement; not assignable through `assignLicense` |
| Standalone EMS E5 | 0; redundant for this test because the E5 suite includes the required identity/management plans |

For a customer deployment, license only real users who need the underlying Microsoft 365 workloads or Copilot. The governance application itself does not require every monitored user to hold a dashboard-specific license.

## Operational cost drivers

The variables that should be captured during customer intake are:

- Number of Teams, channels, users, guests, OneDrives, findings, and daily snapshots.
- Collector frequency and history retention.
- Application Insights sampling and retention.
- Number of dashboard users and peak concurrency.
- Public authenticated ingress versus private endpoints and customer network controls.
- Backup, disaster recovery, zone redundancy, and support-plan requirements.
- Live notification volume and any downstream workflow services.
- Microsoft 365 and Copilot seats already owned versus newly purchased.

## Cost controls

- Keep B1 for a validated small pilot; resize only from measured CPU, memory, and latency.
- Use telemetry sampling and a daily cap.
- Set explicit data retention for Tables, evidence blobs, and logs.
- Tag every resource with customer, environment, owner, cost center, and data classification.
- Configure a resource-group budget and alerts after deployment.
- Export actual Azure Cost Management data after 7 and 30 days and replace estimates with observed run rates.
- Keep customer licensing as a separate line item backed by a reseller or Microsoft quote.
