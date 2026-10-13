# Production operations

## Deployment and approval

1. Create a customer configuration with `scripts/Deploy-Customer.ps1 -Initialize -ConfigPath customer-deployment.json`.
2. Add customer Entra security-group object IDs to `access.roleGroupObjectIds`.
3. Run `scripts/Deploy-Customer.ps1 -ConfigPath customer-deployment.json -PreflightOnly` from the customer-approved network.
4. Review the SKU, permissions, budget, networking, and role-assignment output before administrator consent.
5. Deploy in read-only and dry-run mode. Run `Test-Deployment.ps1` and `Test-ReadOnlyPilot.ps1` before any execution feature is considered.

The JSON configuration contains identifiers and policy choices, but no credentials. Protect it as customer configuration and review changes through source control.

## Easy Auth credential lifecycle

The installer stores the Entra client credential in Key Vault and puts only a Key Vault reference in Function App settings. A dedicated managed identity has `Key Vault Secrets User`; the collector identity cannot read the secret.

Rotate before expiry:

```powershell
.\scripts\Rotate-EasyAuthCredential.ps1 -TenantId <tenant-guid>
```

Rotation appends a replacement credential, updates Key Vault, refreshes App Service references, runs non-mutating authentication validation, and only then deletes superseded installer credentials. Use customer alerting to notify at 60, 30, and 14 days before certificate or app-secret expiry.

## Backup, restore, and disaster recovery

Production defaults to `Standard_GRS`. Customers with an approved zone-capable region may select `Standard_GZRS`. Azure Storage redundancy protects against infrastructure failure but is not a substitute for logical backups.

```powershell
.\scripts\Backup-Governance.ps1 -TenantId <tenant-guid>
.\scripts\Restore-Governance.ps1 -TenantId <tenant-guid> -BackupDirectory <path>
```

The backup uses managed Azure credentials and exports every table and blob with SHA-256 checksums and a manifest. Store backups in a separate subscription/account or approved immutable repository, not in the deployed resource group.

Recommended objectives:

| Deployment | Backup cadence | Target RPO | Target RTO |
| --- | --- | --- | --- |
| Pilot | Daily | 24 hours | 8 hours |
| Department | Every 6 hours | 6 hours | 4 hours |
| Enterprise | Every hour plus GZRS where available | 1 hour | 2 hours |

Test restore quarterly into an isolated recovery resource group. Validate record counts, checksums, authenticated routes, source freshness, and role boundaries. Customer policy and Azure regional capabilities control the final objectives.

## Uninstall and rollback

Always inspect the uninstall plan first:

```powershell
.\scripts\Uninstall-Governance.ps1 -TenantId <tenant-guid> -PlanOnly
.\scripts\Uninstall-Governance.ps1 -TenantId <tenant-guid>
```

Uninstall backs up first, removes the Entra application, deletes the dedicated resource group after confirmation, and retains local install state until those operations succeed. `-PreserveResourceGroup` removes only the Entra application and local state; use it only with a documented resource-retention decision.

Rollback verifies the prior release checksum, redeploys that exact package, and optionally restores a matching backup:

```powershell
.\scripts\Rollback-Governance.ps1 -ConfigPath customer-deployment.json `
  -PreviousReleaseZip <release.zip> -PreviousReleaseSha256 <release.zip.sha256> `
  -BackupDirectory <optional-backup>
```

## CI/CD controls

- `validate.yml`: Node 24, dependency install, 170 tests, JavaScript/PowerShell syntax, and Bicep build.
- `release.yml`: semantic `vX.Y.Z` tags, immutable GitHub release, SHA-256 checksum, and GitHub OIDC build-provenance attestation.
- `deploy.yml`: OIDC Azure login and GitHub Environment approval. Keep `preflight_only` enabled until reviewers approve the production change.

Configure each GitHub Environment with required reviewers, branch/tag restrictions, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ENVIRONMENT`, and the reviewed `SAM_DEPLOYMENT_CONFIG`. The federated principal needs Azure deployment/RBAC rights and explicitly reviewed Microsoft Graph application permissions for app-registration and consent operations.

## SharePoint unattended evidence

Run the consent-explicit setup from a customer administration workstation:

```powershell
.\scripts\Configure-SharePointCertificateAuth.ps1 -TenantId <tenant-guid> `
  -SharePointAdminUrl https://<tenant>-admin.sharepoint.us -ConsentSitesFullControlAll
```

The private key remains in the current user's certificate store. Transfer it to the approved automation host or Key Vault certificate process according to customer policy. SharePoint requires `Sites.FullControl.All` for tenant-wide `Get-SPOSite` administration even though the evidence exporter only reads. Record this exception and review it at least quarterly. Use the generated client ID and thumbprint with `Export-WorkspaceEvidence.ps1`.
