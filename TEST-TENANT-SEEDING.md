# Comprehensive test-tenant seeding

Use this only in an empty, disposable Microsoft 365 test tenant. The scripts create objects prefixed with `samtest` and can delete those objects with `-Remove`.

## 1. Confirm purchased SKUs

Product catalog IDs are used to acquire trials. The seed script instead needs each tenant subscription's exact Graph `skuPartNumber`.

```powershell
Connect-MgGraph -TenantId <tenant-id> -Environment USGov -UseDeviceAuthentication -ContextScope Process -Scopes Organization.Read.All
Invoke-MgGraphRequest -Method GET -Uri '/v1.0/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits' |
    Select-Object -ExpandProperty value |
    Select-Object skuPartNumber, skuId, consumedUnits, prepaidUnits
```

Record the `skuPartNumber` values for the Microsoft 365 base licence and any add-ons to assign. Ensure enough seats exist for 16 active accounts when creating all personas. Do not pass a catalog Product ID or a `skuId` to `-LicenseSkuPartNumber`.

## 2. Seed Graph objects and licences

Run this from the secure GCC High workstation. By default, the six persona passwords are entered into hidden local prompts and are not printed or saved. For unattended seeding, use `-DeferPersonaPasswordSetup`; the script generates unknown temporary passwords and the administrator resets the six accounts in Entra before role testing.

```powershell
.\scripts\Seed-TestTenant.ps1 `
    -TenantId <tenant-id> `
    -Environment USGov `
    -ThisIsATestTenant `
    -EnableGuestInvites `
    -CreateSignInPersonas `
    -DeferPersonaPasswordSetup `
    -CreateGovernanceGroups `
    -CreateChannels `
    -LicenseSkuPartNumber <base-skuPartNumber>,<optional-addon-skuPartNumber>
```

The default Graph login uses the system browser. When this VS Code window already has a verified isolated Azure CLI profile, add `-UseAzureCliToken` to reuse its government Graph token. This mode can perform only operations already permitted to the Azure CLI token; delegated operations such as adding shared-channel members may still require an interactive Graph consent containing `ChannelMember.ReadWrite.All`.

This creates users, role-test personas, governance security groups, Teams, standard/private/shared channels, files, guests, and representative sharing conditions. Guest creation and anonymous links may still be refused by tenant policy; the script records those outcomes without weakening unrelated controls.

## 3. Provision OneDrive and SharePoint scenarios

Run this in the administrator's own PowerShell window because `Connect-SPOService` may require interactive authentication.

```powershell
.\scripts\Seed-TestTenant-SharePoint.ps1 `
    -AdminUrl https://<tenant>-admin.sharepoint.us `
    -ThisIsATestTenant `
    -ProvisionOneDrive
```

Personal-site provisioning is asynchronous. After the sites exist, add the OneDrive files and permission scenarios:

```powershell
.\scripts\Seed-TestTenant.ps1 `
    -TenantId <tenant-id> `
    -Environment USGov `
    -ThisIsATestTenant `
    -SeedOneDriveContent `
    -SharePointAdminUrl https://<tenant>-admin.sharepoint.us `
    -TemporaryOneDriveAdminLoginName <administrator-upn>
```

Run the OneDrive command with the default interactive Graph login so the administrator can consent to `Files.ReadWrite.All`. Do not add `-UseAzureCliToken` unless that token already contains a file-write permission; the standard Azure CLI Graph token does not. Delegated file permission also requires site-level access, so the command temporarily elevates the administrator on only Alex, Adele, and Patti's personal sites and removes all three elevations in a `finally` block. `-SeedOneDriveContent` is an isolated mode: it reads the four required existing users, updates only the three personal drives, and exits without refreshing users, groups, or Teams.

When temporary OneDrive elevation is requested, the script automatically uses Graph device-code authentication to avoid hidden or canceled WAM windows. Complete the displayed code promptly; for GCC High, use `https://login.microsoftonline.us/device` if the government sign-in page is not opened automatically.

After Graph sign-in, SharePoint opens a separate system-browser prompt for the same administrator. This is expected: Graph and SharePoint maintain separate authentication sessions. The script explicitly bypasses the SharePoint WAM broker because its native interop can fail in embedded terminals.

Re-running either command is supported. If a OneDrive is not ready, wait and rerun the second command.

## 4. Deploy in dry-run mode

Keep the Azure CLI profile isolated in this VS Code window before any `az` command.

```powershell
$env:AZURE_CONFIG_DIR = "$HOME\.azure-sam-gcch"
az cloud set --name AzureUSGovernment
az login --tenant <tenant-id>
az account set --subscription <subscription-id>

.\scripts\Install-Governance.ps1 `
    -TenantId <tenant-id> `
    -SubscriptionId <subscription-id> `
    -Location usgovvirginia `
    -Cloud AzureUSGovernment `
    -IncludeUsageReports `
    -IncludeCopilot `
    -EnableExecution `
    -ExecutionMode dry-run `
    -EnableProvisioning `
    -EnableLinkRevocation `
    -EnableOneDriveSharingReview `
    -EnableOneDriveSharingRevocation `
    -EnableLifecycleExecution `
    -NotificationMode dry-run
```

Add sensitivity labels only after replacing names and IDs with the test tenant's real published label inventory.

## 5. Assign all dashboard roles

The installer writes `.install\<tenant-id>.json`. Use its non-secret `apiClientId` to map each governance group to the matching app role:

```powershell
$install = Get-Content ".install\<tenant-id>.json" -Raw | ConvertFrom-Json
.\scripts\Seed-TestTenant.ps1 `
    -TenantId <tenant-id> `
    -Environment USGov `
    -ThisIsATestTenant `
    -CreateGovernanceGroups `
    -ApiClientId $install.apiClientId
```

Test each role in a separate browser profile. App-role tokens can remain cached until the user signs out and signs in again.

## 6. Validate before enabling live actions

```powershell
.\scripts\Test-Deployment.ps1 -TenantId <tenant-id>
```

Confirm collection, risk scoring, cases, owner tasks, role boundaries, evidence, and dry-run execution records. Then enable and test one mutation family at a time: notifications, provisioning, sharing revocation, lifecycle archive, and finally guarded lifecycle deletion. Keep deletion last and verify hold/retention evidence first.

## Cleanup

```powershell
.\scripts\Seed-TestTenant.ps1 `
    -TenantId <tenant-id> `
    -Environment USGov `
    -ThisIsATestTenant `
    -Remove
```

Cleanup deletes the prefixed users, guests, groups, Teams, and their connected sites. It does not cancel purchased trials, remove the deployed Azure resources, or revert SharePoint governance reports.
