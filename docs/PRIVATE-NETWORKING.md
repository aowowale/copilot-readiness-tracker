# Private networking and DNS

Set `network.privateNetworking` to `true` to deploy:

- Function App regional VNet integration.
- A private endpoint for inbound Function App traffic.
- Blob, Table, and Key Vault private endpoints.
- Private DNS zones and links for the selected Azure cloud.

The template uses these GCC High zones:

| Service | Private DNS zone |
| --- | --- |
| App Service | `privatelink.azurewebsites.us` |
| Blob | `privatelink.blob.core.usgovcloudapi.net` |
| Table | `privatelink.table.core.usgovcloudapi.net` |
| Key Vault | `privatelink.vaultcore.usgovcloudapi.net` |

Commercial deployments use the corresponding `azurewebsites.net`, `core.windows.net`, and `vaultcore.azure.net` zones.

## Customer DNS integration

The template links Azure Private DNS directly to its VNet. Customers using central DNS must also configure conditional forwarding from on-premises/AVD DNS to Azure DNS Private Resolver or an approved DNS forwarder. Confirm that the deployment agent and user network resolve the Function App default hostname to the private endpoint address.

Validate from the actual administration and user networks:

```powershell
Resolve-DnsName <function-app>.azurewebsites.us
Resolve-DnsName <storage>.table.core.usgovcloudapi.net
Resolve-DnsName <storage>.blob.core.usgovcloudapi.net
Resolve-DnsName <vault>.vault.usgovcloudapi.net
Test-NetConnection <function-app>.azurewebsites.us -Port 443
```

## Closing public ingress

Keep `network.disablePublicIngress` false for the initial code deployment unless the deployment runner already has private DNS and VNet reachability. To set it true in the same run, also set `network.privateDeploymentAgentReady` true. The installer refuses the unsafe combination otherwise.

Before closing ingress, verify:

1. Private endpoint connection state is Approved.
2. DNS returns private addresses from the deployment runner and user network.
3. Kudu/SCM deployment resolves through the App Service private DNS zone.
4. Function App can resolve and reach private Storage and Key Vault endpoints through VNet integration.
5. Easy Auth redirect URI remains the normal HTTPS application hostname; do not replace it with a private IP.
