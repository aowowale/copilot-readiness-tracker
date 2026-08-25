# Start here: before entering the customer tenant

This is the literal preparation sequence for the Microsoft 365 Copilot Readiness dashboard.

## What exists today

The working folder is:

```text
C:\Users\aawowale\OneDrive - Microsoft\Documents\VSCode\SAM
```

It currently contains:

| File | What it is | Take it to the customer AVD? |
| --- | --- | --- |
| `index.html` | Working dashboard prototype with sample governance data | Yes |
| `README.md` | Product status and limitations | Yes |
| `CUSTOMER-DEPLOYMENT.md` | GCC High architecture and deployment runbook | Yes |
| `CLOUD-SYNC-SETUP.md` | Optional Microsoft Lists task-sync instructions only | Yes, as reference |
| `.nojekyll` | Prevents static hosts from applying Jekyll processing | Yes |
| `.git` | Local source-control history and metadata | No |

The files above are a **customer preparation/demo package**. They are not yet a production installer. The following production files do not exist yet because they depend on customer hosting decisions:

- Azure Government infrastructure template.
- Backend API.
- Scheduled Microsoft Graph collector.
- SharePoint/RCD collector.
- Storage schema and migrations.
- Environment configuration template.
- Deployment and rollback scripts.

Do not tell the customer that copying `index.html` installs tenant collection. It only opens the sample dashboard.

## Step 1: Build the safe preparation ZIP

Open PowerShell in VS Code and run:

```powershell
Set-Location "C:\Users\aawowale\OneDrive - Microsoft\Documents\VSCode\SAM"
.\scripts\New-CustomerPrepPackage.ps1
```

The script creates:

```text
C:\Users\aawowale\OneDrive - Microsoft\Documents\VSCode\SAM\artifacts\SAM-customer-prep-YYYYMMDD-HHMMSS.zip
```

That ZIP contains only the five approved files and a manifest. It excludes `.git`, tokens, browser storage, certificates, tenant IDs, client IDs, and any local Azure CLI profile.

## Step 2: Verify the ZIP before moving it

Run:

```powershell
$zip = Get-ChildItem .\artifacts\SAM-customer-prep-*.zip |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

$zip.FullName
tar -tf $zip.FullName
```

Expected contents:

```text
index.html
README.md
CUSTOMER-DEPLOYMENT.md
CLOUD-SYNC-SETUP.md
.nojekyll
PACKAGE-MANIFEST.txt
```

If anything resembling a `.pfx`, `.cer`, `.env`, token, secret, Azure profile, or customer export appears, stop and do not transfer the ZIP.

## Step 3: Review the demo locally

Start the local server:

```powershell
Set-Location "C:\Users\aawowale\OneDrive - Microsoft\Documents\VSCode\SAM"
python -m http.server 8080
```

Open:

```text
http://localhost:8080/index.html#governance
```

Confirm these facts before demonstrating it:

1. The Tenant Governance view says it is using sample data.
2. No customer tenant findings are represented.
3. Task sync is only for the 42 program tasks in Microsoft Lists.
4. There are no tenant mutation or remediation controls.

## Step 4: Prepare a non-secret customer intake sheet

Ask the customer for these values. They are identifiers and decisions, not credentials:

| Required item | Example or guidance |
| --- | --- |
| Customer organization | Display name only |
| Microsoft Entra tenant ID | GUID; do not request tokens or passwords |
| Primary tenant domain | For example, `contoso.onmicrosoft.us` |
| SharePoint admin URL | Customer `https://...-admin.sharepoint.us` URL |
| Azure Government subscription ID/name | Customer-approved hosting subscription |
| Approved Azure Government region | Selected by customer cloud/security owner |
| Resource naming prefix | Customer naming standard |
| Required tags | Cost center, owner, environment, data classification |
| Approved data store | Prefer Azure Storage for the small pilot unless policy says otherwise |
| Network model | Entra-protected public ingress or customer private networking |
| Retention period | Snapshot and diagnostic-log retention |
| Governance access group | Existing or planned Entra group for dashboard users |
| Entra administrator contact | Can approve app permissions/admin consent |
| SharePoint administrator contact | Can validate site inventory and RCD |
| Pilot Teams | 5-10 representative Teams selected by the customer |
| Activity source | Approved report/import/audit aggregate, or `Unknown` for phase one |

Never collect passwords, access tokens, client secrets, private certificates, PFX files, recovery codes, or exported browser sessions in the intake sheet.

## Step 5: Arrange the customer working session

The first session needs these people or approved delegates:

1. Azure Government subscription owner or contributor.
2. Microsoft Entra administrator able to approve application permissions.
3. SharePoint Administrator.
4. Customer security/network representative if private access is required.
5. Governance owner who can select and validate the pilot Teams.

Send `CUSTOMER-DEPLOYMENT.md` before the session. The customer should approve the architecture and the read-only pilot boundary before any resources or app registrations are created.

## Step 6: Move the package into the approved environment

Use only the customer's approved transfer method. Move the generated ZIP, not the entire `SAM` folder and not your Windows user profile.

Inside the secure customer AVD:

1. Save the ZIP in a customer-approved working directory.
2. Scan it using the customer's required security tooling.
3. Extract it into a new project folder.
4. Open that folder in VS Code.
5. Review `PACKAGE-MANIFEST.txt` and compare the extracted file list.
6. Open `CUSTOMER-DEPLOYMENT.md` before signing in to Azure.

## Step 7: Isolate Azure CLI before customer login

Run this in the customer AVD terminal before any `az` command:

```powershell
$env:AZURE_CONFIG_DIR = "$HOME\.azure-sam-customer-gcch"
az cloud set --name AzureUSGovernment
az login --tenant <customer-tenant-id>
az account show --output table
```

Confirm that the cloud is Azure Government and that the displayed tenant/subscription belong to the intended customer. Do not log out or modify another VS Code window's Azure session.

## Step 8: Stop at the implementation gate

Do not create production resources yet unless the customer has confirmed:

1. Subscription and region.
2. Storage platform.
3. Network requirements.
4. Entra and SharePoint administrator participation.
5. Pilot Team list.
6. Activity treatment: approved source or explicitly `Unknown`.

Once those decisions are recorded, use them to generate the infrastructure template, backend API, collectors, configuration template, and deployment scripts. Those deployable files will form a second package and will replace the demo-only transfer process.
