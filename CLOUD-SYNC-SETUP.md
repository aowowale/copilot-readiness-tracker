# Microsoft Lists cloud sync setup

The tracker can remain local, or synchronize all 42 tasks through a Microsoft List. No client secret is used or stored.

## 1. Serve the tracker

Cloud sign-in cannot redirect to a `file://` URL. Serve this folder locally:

```powershell
Set-Location "C:\Users\aawowale\OneDrive - Microsoft\Documents\VSCode\SAM"
python -m http.server 8080
```

Open <http://localhost:8080/index.html>.

For team use, publish `index.html` from an approved HTTPS web host and use that exact HTTPS URL instead.

## 2. Register the Entra application

1. Open **Microsoft Entra admin center > Identity > Applications > App registrations > New registration**.
2. Use a single-tenant registration unless your organization requires otherwise.
3. Under **Authentication**, add a **Single-page application (SPA)** redirect URI:
   - Local: `http://localhost:8080/index.html`
   - Hosted: the exact HTTPS URL that serves `index.html`
4. Under **API permissions**, add these delegated Microsoft Graph permissions:
   - `Sites.ReadWrite.All`
   - `Sites.Manage.All`
5. Grant administrator consent if required by tenant policy.
6. Copy the **Application (client) ID** and **Directory (tenant) ID**.

For GCC High, create the registration in the government Entra portal and select **GCC High** in the tracker setup.

## 3. Connect the tracker

1. Select **Cloud sync** in the tracker header.
2. Choose the Microsoft cloud.
3. Enter the tenant ID or verified tenant domain.
4. Enter the application client ID.
5. Enter the full SharePoint site URL where the List should live.
6. Keep or change the List name, then select **Connect & sync**.

The first sync creates the List, provisions its columns, and uploads missing tasks. Later syncs reconcile each task independently using its last-modified timestamp. A newer shared task is downloaded; a newer local task is uploaded.

## Operational notes

- Users need access to the target SharePoint site and permission to use the approved Entra application.
- Sync is manual so users control when shared changes are exchanged.
- Local browser storage remains available as an offline working copy.
- Use **Backup JSON** before changing tenants, sites, or List names.
- The client ID, tenant, site URL, and List name are stored locally. Access tokens are managed by MSAL; no passwords, client secrets, or tokens are written into tracker data or exports.
