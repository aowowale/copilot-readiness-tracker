# Manual data import (no backend required)

The dashboard can run without deploying the automated collector. If GCC High policy,
approvals, or timing prevent running the connector, an administrator can **export**
governance data with read-only tools and **import** it into the dashboard.

The dashboard chooses its data source automatically, in this order:

1. **Live tenant data** — the deployed collector API at `/api/workspaces` (if reachable).
2. **Manual import** — data you import here, stored only in your browser (`localStorage`).
3. **Sample data** — clearly labeled demo records used when neither of the above exists.

The source is always labeled in the header badge and the banner. Sample data can never be
mistaken for real tenant findings.

---

## 1. Export the data (read-only)

Use the provided script, which uses Microsoft Graph PowerShell and modifies nothing:

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser   # first time only
cd scripts
# GCC High:
.\Export-GovernanceData.ps1 -Environment USGov -OutFile governance-import.json
# Commercial:
.\Export-GovernanceData.ps1 -Environment Global -OutFile governance-import.json
```

By default the script enumerates the **entire tenant** (every Teams-enabled group). Pass
`-TeamIds <id1>,<id2>` to limit the export to a specific subset.

The script pulls, per Team:

| Field | Source |
| --- | --- |
| `name`, `type` | `Get-MgGroup` (display name, visibility) |
| `owners` | `Get-MgGroupOwner` |
| `members`, `guests` | `Get-MgGroupMember` (`userType eq 'Guest'` split) |
| `channelCount` | `Get-MgTeamChannel` |

Fields that require additional validated reports are left honest:

- `activityDays` and `activeChannels` → `null` (shown as **Unknown**, never "Inactive")
- `exposure` → `"Unknown"` until a SharePoint sharing review provides a real signal
- `rcd`, `site` → defaults you fill from your RCD report and `Get-SPOSite` export

### Optional: merge Teams activity (fills activityDays / activeChannels)

Export the **Teams activity** report (Teams admin center → Analytics & reports → Usage
reports → Teams activity, or `Get-MgReportTeamActivityDetail`) as CSV, then merge it:

```powershell
.\Export-GovernanceData.ps1 -Environment USGov -TeamsActivityCsv .\TeamsActivity.csv
```

The merge matches on **Team Id**, deriving `activityDays` from `Last Activity Date` and
`activeChannels` from `Active Channels`. Rows that do not match (for example when the report
conceals identifiers) stay **Unknown** — nothing is guessed.

### Optional: add SharePoint site + exposure

```powershell
# Requires the SharePoint Online Management Shell, ITAR region for GCC High.
Connect-SPOService -Url https://<tenant>-admin.sharepoint.us -Region ITAR
Get-SPOSite -Limit All | Select Url, SharingCapability, Owner
```

Map each site back to its Team by URL and set `site`, and set `exposure`
(`High` / `Medium` / `Low`) only where you have a validated sharing signal.

### Optional: add Restricted Content Discovery coverage

Export your RCD coverage report and set `rcd: true` for covered sites.

---

## 2. Import into the dashboard

1. Open the dashboard → **Tenant governance** view.
2. Click **Download template** to see the exact JSON shape (or use your exported file).
3. Click **Import data** and select your `governance-import.json`.
4. The badge changes to **Manual import** with the import timestamp.

To go back to the demo, click **Use sample data**. To try the live collector again,
click **Retry live connector**.

The import stays in your browser only — it is never uploaded anywhere from this page.

---

## 3. Import JSON schema

The importer accepts a bare array, `{ "workspaces": [ ... ] }`, or the collector API
envelope. Each workspace record has these 15 fields:

```jsonc
{
  "id": "team-001",                 // string, unique
  "name": "Finance Operations",     // string, required
  "type": "Private team",           // string
  "activityDays": 12,               // number OR null (null => "Unknown")
  "activeChannels": 5,              // number OR null (null => "Unknown")
  "channelCount": 7,                // number
  "owners": ["Alex Wilber"],        // array of strings (empty => "No owner")
  "members": 46,                    // number
  "guests": 2,                      // number
  "exposure": "High",               // "High" | "Medium" | "Low" | "Unknown"
  "exposureCount": 3,               // number
  "rcd": true,                      // boolean
  "lifecycle": "Review",            // string
  "site": "/sites/FinanceOperations", // string
  "findings": ["..."]               // array of strings
}
```

Validation rules applied on import:

- `name` is required; records without one are rejected.
- `activityDays` / `activeChannels` that are missing or non-numeric become `null` → **Unknown**.
- `exposure` outside the allowed set becomes `"Unknown"`.
- `owners` / `findings` accept an array, or a `;`/`|`-separated string.
- All values are HTML-escaped when rendered.

A ready-to-edit sample is in [governance-import.sample.json](governance-import.sample.json).
