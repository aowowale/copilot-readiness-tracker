# Load and scale testing

`Test-Scale.ps1` exercises authenticated GET routes only. It does not trigger collection or execute governance actions.

| Profile | Documented tenant size | Concurrent clients | Requests | P95 threshold | Error threshold |
| --- | --- | ---: | ---: | ---: | ---: |
| Pilot | Up to 250 workspaces | 5 | 100 | 2.0 seconds | 1% |
| Department | 251-2,500 workspaces | 15 | 600 | 2.5 seconds | 1% |
| Enterprise | 2,501-10,000 workspaces | 30 | 1,800 | 3.0 seconds | 1% |

Run each applicable profile from the customer network after loading representative data:

```powershell
.\scripts\Test-Scale.ps1 -TenantId <tenant-guid> -Profile pilot
.\scripts\Test-Scale.ps1 -TenantId <tenant-guid> -Profile department
.\scripts\Test-Scale.ps1 -TenantId <tenant-guid> -Profile enterprise
```

The result records P50/P95/P99 latency, HTTP status counts, concurrency, elapsed time, and pass/fail thresholds. Store the JSON with acceptance evidence.

These profiles validate API/dashboard read load, not Microsoft Graph collection throughput. Collection scale must additionally record total workspaces, Graph throttles/retries, run duration, source freshness, Table transaction rate, and Function memory. For tenants above 10,000 workspaces, establish a customer-specific profile and consider partitioned collection, Premium App Service capacity, and a staged Graph schedule before production approval.
