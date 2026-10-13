const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const artifacts = path.join(repoRoot, "artifacts");
const tools = path.join(artifacts, ".document-tools", "node_modules");
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LeaderType,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopPosition,
  TabStopType,
  TextRun,
  WidthType,
} = require(path.join(tools, "docx"));
const pptxgen = require(path.join(tools, "pptxgenjs"));
const JSZip = require(path.join(tools, "jszip"));

const DOCX_OUT = path.join(artifacts, "Microsoft-365-Copilot-Readiness-Customer-Guide.docx");
const PPTX_OUT = path.join(artifacts, "Microsoft-365-Copilot-Readiness-Customer-Presentation.pptx");
const NOTES_OUT = path.join(artifacts, "presentation-notes.json");
const DASHBOARD_IMAGE = path.join(artifacts, "dashboard-live.png");
const presentationNotes = [];

const C = {
  charcoal: "252A2D",
  charcoal2: "343A3D",
  teal: "087F7A",
  teal2: "10A39A",
  mint: "DDF3EF",
  coral: "E46C62",
  amber: "D9A326",
  ink: "172326",
  gray: "667276",
  line: "CFD8D8",
  paper: "F7F9F8",
  white: "FFFFFF",
};

const contentWidth = 9360;
const border = { style: BorderStyle.SINGLE, size: 1, color: C.line };
const borders = { top: border, bottom: border, left: border, right: border };

function p(text, options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 120, line: options.line ?? 280 },
    alignment: options.align,
    keepNext: options.keepNext,
    children: [new TextRun({
      text,
      bold: options.bold,
      italics: options.italics,
      color: options.color || C.ink,
      size: options.size,
    })],
  });
}

function rich(runs, options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 120, line: 280 },
    alignment: options.align,
    children: runs.map((run) => new TextRun(run)),
  });
}

function h(text, level = 1, pageBreakBefore = false) {
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
    pageBreakBefore,
    keepNext: true,
    children: [new TextRun(text)],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: "bullets", level },
    spacing: { after: 75, line: 270 },
    children: [new TextRun(text)],
  });
}

function step(text) {
  return new Paragraph({
    numbering: { reference: "steps", level: 0 },
    spacing: { after: 85, line: 280 },
    children: [new TextRun(text)],
  });
}

function callout(title, text, color = C.teal) {
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: [260, 9100],
    rows: [new TableRow({
      children: [
        new TableCell({
          width: { size: 260, type: WidthType.DXA },
          shading: { fill: color, type: ShadingType.CLEAR },
          borders,
          children: [p("")],
        }),
        new TableCell({
          width: { size: 9100, type: WidthType.DXA },
          shading: { fill: C.paper, type: ShadingType.CLEAR },
          borders,
          margins: { top: 150, bottom: 150, left: 220, right: 220 },
          children: [
            p(title, { bold: true, color, after: 45 }),
            p(text, { after: 0 }),
          ],
        }),
      ],
    })],
  });
}

function table(headers, rows, widths) {
  const row = (values, header = false) => new TableRow({
    tableHeader: header,
    children: values.map((value, index) => new TableCell({
      width: { size: widths[index], type: WidthType.DXA },
      shading: header ? { fill: C.charcoal, type: ShadingType.CLEAR } : undefined,
      borders,
      margins: { top: 100, bottom: 100, left: 125, right: 125 },
      verticalAlign: "center",
      children: [new Paragraph({
        spacing: { after: 0, line: 240 },
        children: [new TextRun({ text: String(value), bold: header, color: header ? C.white : C.ink, size: 19 })],
      })],
    })),
  });
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: widths,
    rows: [row(headers, true), ...rows.map((values) => row(values))],
  });
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

function tocEntry(title, page, level = 0) {
  return new Paragraph({
    indent: { left: level * 280 },
    spacing: { after: 70, line: 245 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: LeaderType.DOT }],
    children: [
      new TextRun({ text: title, bold: level === 0, size: level === 0 ? 21 : 20, color: level === 0 ? C.ink : C.gray }),
      new TextRun({ text: `\t${page}`, size: 20, color: C.gray }),
    ],
  });
}

function code(text) {
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: [contentWidth],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: contentWidth, type: WidthType.DXA },
      shading: { fill: C.charcoal, type: ShadingType.CLEAR },
      borders,
      margins: { top: 140, bottom: 140, left: 180, right: 180 },
      children: text.split("\n").map((line) => new Paragraph({
        spacing: { after: 30 },
        children: [new TextRun({ text: line, font: "Consolas", color: C.white, size: 18 })],
      })),
    })] })],
  });
}

function architectureTable() {
  return table(
    ["Experience", "Application", "Data and identity"],
    [
      ["Authorized governance users\nRole-specific dashboard", "Azure Function App\nDashboard + protected API", "App Service Easy Auth\nSingle-tenant Entra app"],
      ["Workspace owners\nGovernance operators", "Scheduled/manual collector\nPolicy and workflow services", "Read-only managed identity\nMicrosoft Graph GCC High"],
      ["Approvers, executors, auditors", "Versioned findings, cases, tasks, evidence", "Azure Tables + Blob\nApplication Insights"],
    ],
    [2900, 3260, 3200],
  );
}

async function removeUnusedDefaultNumbering(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const numberingFile = zip.file("word/numbering.xml");
  let xml = await numberingFile.async("string");
  xml = xml.replace(/<w:abstractNum w:abstractNumId="1".*?<\/w:abstractNum>/s, "");
  xml = xml.replace(/<w:num w:numId="1"><w:abstractNumId w:val="1"\/><w:lvlOverride.*?<\/w:num>/s, "");
  zip.file("word/numbering.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function createDocx() {
  const children = [];
  children.push(
    p("MICROSOFT 365 COPILOT READINESS", { bold: true, color: C.teal, size: 22, after: 420 }),
    p("Customer Deployment, Operations and Solution Guide", { bold: true, size: 46, after: 220 }),
    p("A practical guide for customer discovery, technical review, installation, pilot acceptance, operations, cost planning, security, and user experience.", { size: 25, color: C.gray, after: 600 }),
    callout("Document purpose", "Use this guide to explain the solution to business, security, Microsoft 365, Azure, and operations stakeholders; plan a customer-owned deployment; and answer common due-diligence questions. It is not a contract, security accreditation, or price quote."),
    p("Prepared from the implemented repository and validated GCC High pilot", { bold: true, color: C.gray, after: 40 }),
    p("Version 1.0 | October 2026 | Customer identifiers intentionally omitted", { color: C.gray }),
    pageBreak(),
    h("How to use this guide"),
    p("The first sections support executive and customer conversations. The middle sections support architecture, security, and deployment reviews. The final sections support operations, handoff, frequently asked questions, and presentation preparation."),
    callout("Verified evidence", "The reference deployment completed 20 of 20 live deployment checks and 170 of 170 repository tests. It collected eight workspaces, created eight owner tasks, and calculated risk for all eight. The live deployment used a read-only collector, no executor identity, and dry-run behavior for tenant-changing operations.", C.teal),
    p("Important status language", { bold: true }),
    bullet("Verified: implemented and exercised in the reference GCC High deployment."),
    bullet("Implemented, tenant validation required: code exists, but availability, licensing, consent, or exact behavior must be confirmed in the customer tenant."),
    bullet("Optional: deployed only when explicitly selected and approved."),
    bullet("Roadmap: a recommended improvement, not a current product claim."),
    pageBreak(),
    p("Table of Contents", { bold: true, size: 34, after: 260 }),
    tocEntry("How to use this guide", 2),
    tocEntry("1. Executive summary", 5),
    tocEntry("2. What was created", 6),
    tocEntry("3. User experience and personas", 7),
    tocEntry("4. Feature catalog", 9),
    tocEntry("5. Architecture and data flow", 10),
    tocEntry("6. Technology stack", 11),
    tocEntry("7. Security, privacy, and compliance posture", 12),
    tocEntry("8. Prerequisites and customer decisions", 13),
    tocEntry("9. Installation procedure", 14),
    pageBreak(),
    p("Table of Contents (continued)", { bold: true, size: 28, after: 220 }),
    tocEntry("10. Identity and permission model", 16),
    tocEntry("11. Pilot acceptance and test plan", 17),
    tocEntry("12. Operations and support model", 18),
    tocEntry("13. Cost and capacity planning", 19),
    tocEntry("14. Limitations, risks, and roadmap", 20),
    tocEntry("15. Customer discovery and due diligence", 21),
    tocEntry("16. Handoff, RACI, and presentation checklist", 23),
    tocEntry("Appendix A. Deployment troubleshooting", 24),
    tocEntry("Appendix B. Glossary", 25),
    tocEntry("Appendix C. Source documents", 26),
  );

  children.push(
    h("1. Executive summary", 1, true),
    p("Microsoft 365 Copilot can amplify the value of an organization's content, but it also makes existing access, ownership, sharing, lifecycle, and content-discovery weaknesses more visible. This solution gives governance teams a customer-owned operational view of Teams, Microsoft 365 Groups, SharePoint, OneDrive, Copilot usage, and agents, then routes evidence-backed work to the right people."),
    p("The solution is intentionally conservative. The collector identity is read-only. Missing or stale evidence is shown as Unknown rather than healthy. Decisions and approvals are recorded before execution. Tenant-changing actions are separated behind an optional executor identity, explicit feature flags, dry-run defaults, revalidation, and post-action verification."),
    table(["Customer outcome", "How the solution supports it"], [
      ["Know the estate", "Normalized inventory of workspaces, owners, members, guests, channels, sites, activity evidence, exposure signals, Copilot seats, and agents."],
      ["Find governance gaps", "Versioned policy checks, risk scoring, source-health warnings, drift alerts, and durable findings."],
      ["Route accountable work", "Owner renewal reviews, mover reviews, escalations, cases, approvals, and auditable decisions."],
      ["Act safely", "Dry-run-first execution, separate identity, bounded actions, two-person approval, typed confirmation, and verification."],
      ["Operate economically", "A small B1 pilot is estimated at $25-$40 per month in Azure before Microsoft 365 licensing and optional controls."],
    ], [2700, 6660]),
    callout("Recommended first engagement", "Run a read-only pilot across 5-10 representative Teams. Reconcile results against Microsoft 365 administration views, validate every data source, establish role assignments and retention, and collect 7- and 30-day Azure cost actuals before broader rollout."),

    h("2. What was created", 1, true),
    p("The repository contains a deployable governance application, infrastructure-as-code, installation and validation automation, a comprehensive synthetic-tenant seed, operational documentation, and automated tests."),
    table(["Layer", "Implemented capability", "Customer value"], [
      ["Web experience", "Authenticated dashboard with Program Plan, Tenant Governance, My Workspaces, Findings, OneDrive, Posture, Requests, AI and Agents, and Program Tasks views.", "A single operational workspace for governance and readiness."],
      ["API and workflows", "Protected APIs for inventory, findings, cases, owner tasks, posture, risk, requests, baselines, notifications, actions, agents, and Copilot data.", "Consistent server-side authorization and durable workflow state."],
      ["Collector", "Scheduled and operator-triggered read-only collection from Microsoft Graph plus approved evidence feeds.", "Repeatable data refresh with source timestamps and warnings."],
      ["Policy and evidence", "Versioned policy packs, stable finding IDs, risk definitions, baselines, drift, suppressions, and audit records.", "Explainable decisions that do not erase history."],
      ["Deployment", "Bicep, PowerShell installer, preflight, app-role configuration, Graph consent, ZIP publication, and live smoke validation.", "Customer-owned and repeatable installation."],
      ["Quality", "170 automated tests and a 20-check live deployment validation in the reference GCC High tenant.", "Evidence for technical review and pilot acceptance."],
    ], [1900, 4100, 3360]),

    h("3. User experience and personas", 1, true),
    p("The experience should make the safest next action obvious for each persona. Users should see only the context and controls needed for their role, while tenant-wide data remains restricted to governance roles."),
    table(["Persona", "Primary job", "Relevant experience"], [
      ["Executive sponsor", "Understand readiness, risk, progress, decisions, and blockers.", "Program Plan, trend, rollout gate, summarized posture."],
      ["Governance reader/auditor", "Inspect evidence without changing state.", "Tenant Governance, Findings, Posture, decision and action history."],
      ["Governance operator", "Triage findings, assign work, manage exceptions, and monitor sources.", "Findings queue, cases, suppressions, collector run, source health."],
      ["Workspace owner", "Complete a guided review and make an accountable lifecycle decision.", "My Workspaces five-step review, risk context, membership and sharing review."],
      ["Approver", "Independently approve requests, exceptions, baselines, archive, and delete decisions.", "Approval queues, evidence, reason capture, conflict-of-duty controls."],
      ["Executor", "Perform only approved, explicitly armed actions and verify results.", "Preview, typed confirmation, execution state, post-action verification."],
    ], [2200, 3400, 3760]),
    h("UX principles", 2),
    bullet("Role-first landing: start each persona in their work queue, not a generic tenant dashboard."),
    bullet("Progressive disclosure: show the decision summary first, with evidence and history available on demand."),
    bullet("Evidence at the point of decision: source, timestamp, freshness, Unknown state, and policy version travel with the action."),
    bullet("Safe language: distinguish record-only, simulated, approved, executed, verified, failed, and uncertain states."),
    bullet("Accessible scanning: high-contrast status, keyboard support, meaningful focus order, plain language, and responsive tables."),
    h("Recommended UX optimization roadmap", 2, true),
    table(["Priority", "Improvement", "Measure"], [
      ["P0", "Role-specific home, consolidated work queue, clearer empty/loading/error states, responsive navigation, and visible data freshness.", "Time to first actionable item; mobile overflow defects; task completion rate."],
      ["P1", "Guided first-run tour, saved views across queues, bulk triage where safe, consistent status vocabulary, and accessible charts.", "Training time; repeated navigation; WCAG review findings."],
      ["P2", "In-product feedback, persona analytics with privacy controls, notification preferences, and customer theming.", "Support requests; adoption by role; completion latency."],
    ], [900, 6000, 2460]),

    h("4. Feature catalog", 1, true),
    table(["Capability", "What it does", "Status / boundary"], [
      ["Workspace inventory", "Correlates Groups, Teams, owners, membership, channels, sites, archive state, and evidence.", "Verified for the reference GCC High pilot."],
      ["Findings and cases", "Creates explainable findings and stable, role-gated governance cases with history.", "Verified; case transitions do not mutate Microsoft 365."],
      ["Owner renewals", "Five-step workspace review, decision register, reassignment, and escalation.", "Implemented; non-response never archives or deletes."],
      ["Mover reviews", "Routes role-change access decisions to managers and workspace owners.", "Feed-based test pathway; HR integration is customer-specific."],
      ["Posture and risk", "Transparent risk-v1 scoring, coverage, trend, source health, suppressions, and configurable definitions.", "Implemented; Unknown prevents a Low rating."],
      ["Baselines and drift", "Approver-managed baselines and deduplicated drift alerts.", "Implemented; acknowledgement does not reset baseline."],
      ["OneDrive review", "Admin metadata plus bounded item-name and permission review; no file content read.", "Optional; 100 items / 3 levels, truncation shown."],
      ["Guest lifecycle", "Cross-workspace guest inventory and age/context for review.", "Creation date is used; sign-in activity is not collected."],
      ["Copilot adoption", "Seats, assignments, availability, and available usage-report adoption.", "Tenant/cloud report availability must be validated."],
      ["Agent inventory", "Catalog bots plus approved evidence-feed agents, with source labeling.", "Some APIs remain tenant-dependent or unavailable in GCC High."],
      ["Requests and provisioning", "Guardrailed catalog requests, separate approval, optional verified provisioning.", "Live use requires executor and tenant-validated label mapping."],
      ["Lifecycle and sharing actions", "Member removal, selected sharing revocation, archive/delete with strict controls.", "Optional; dry run by default; explicit permissions and flags required."],
    ], [1950, 4250, 3160]),

    h("5. Architecture and data flow", 1, true),
    architectureTable(),
    h("End-to-end flow", 2),
    step("An authorized user signs in through App Service Authentication using the customer tenant."),
    step("The API validates tenant, audience, token expiration, and required application role for every protected route."),
    step("The scheduled collector, or an operator-triggered manual run, uses a read-only managed identity to query approved Microsoft Graph endpoints."),
    step("Approved SharePoint, Purview, OneDrive, activity, and agent facts can arrive through a validated evidence feed when no suitable API exists."),
    step("The service normalizes snapshots, evaluates policy, calculates risk, creates or resolves findings, updates tasks, and records source health."),
    step("Users review evidence and move internal governance workflow state according to role. No tenant change occurs unless an optional executor capability is separately enabled and explicitly confirmed."),
    step("Application Insights captures application telemetry; Azure Storage retains the operational records according to customer policy."),
    h("Trust boundaries", 2),
    bullet("Browser boundary: no application credential or tenant-wide Graph token is placed in browser JavaScript."),
    bullet("Read/write boundary: collector and optional executor use separate identities and separate consent."),
    bullet("Customer boundary: Azure resources, app registrations, consent, data, logs, and role groups remain customer-owned."),
    bullet("Evidence boundary: unsupported, failed, missing, or stale sources are Unknown, never silently converted to healthy or inactive."),

    h("6. Technology stack", 1, true),
    table(["Area", "Technology", "Purpose"], [
      ["Runtime", "Node.js 24, ECMAScript modules", "Supported backend runtime and application logic."],
      ["Application host", "Azure Functions v4 on Linux App Service B1", "Dashboard, protected APIs, timer, and operator collector endpoint."],
      ["Frontend", "Self-contained HTML, CSS, and JavaScript", "Operational dashboard without a separate frontend service."],
      ["Identity", "Microsoft Entra ID + App Service Authentication", "Single-tenant sign-in, API audience, and app roles."],
      ["Cloud SDKs", "@azure/functions, @azure/identity, @azure/data-tables, @azure/storage-blob", "Function registration, managed identity, Tables, and Blob access."],
      ["Data", "Azure Tables and Blob Storage", "Governance state, snapshots, evidence, history, and feeds."],
      ["Monitoring", "Application Insights", "Requests, dependencies, exceptions, and operational telemetry."],
      ["Infrastructure", "Bicep", "Repeatable customer-owned Azure deployment and role assignments."],
      ["Automation", "PowerShell + Azure CLI + Microsoft Graph", "Preflight, install, consent, publication, validation, export, and seeding."],
      ["Quality", "Node test runner + Azurite", "Unit, storage, and handler validation with local emulation."],
    ], [1850, 3000, 4510]),
    callout("Government cloud configuration", "Use portal.azure.us, login.microsoftonline.us, graph.microsoft.us, management.usgovcloudapi.net, azurewebsites.us, and the customer's sharepoint.us endpoints. Commercial .com endpoints are not interchangeable with GCC High.", C.coral),

    h("7. Security, privacy, and compliance posture", 1, true),
    table(["Control", "Design"], [
      ["Least privilege", "The reference collector uses reviewed read-only Graph application permissions. Write permissions are not added to the collector."],
      ["Separation of duties", "Reader, Owner, Operator, Approver, Executor, and Auditor roles are enforced by the API. Approver and executor membership can be separated."],
      ["Customer ownership", "Resources, identities, consent, data, and logs are deployed into the customer environment."],
      ["Data minimization", "Only governance fields are normalized. OneDrive content is not read; optional scans inspect bounded names and permission metadata."],
      ["Fail closed", "Unknown evidence blocks low-risk classification and delete approval. Unmapped sensitivity labels fail before provisioning."],
      ["Safe execution", "Dry run is default. Actions are re-read before and after, bounded, audited, and may require second approval and typed confirmation."],
      ["Concurrency and audit", "Expected versions/ETags prevent stale sessions from overwriting decisions; actor, time, reason, policy version, and correlation are retained."],
      ["Transport and platform", "HTTPS only and TLS 1.2 or later. The template uses managed identities and Azure role assignments."],
    ], [2500, 6860]),
    h("Customer security decisions", 2),
    bullet("Public authenticated ingress versus private endpoint and approved network path."),
    bullet("Log and operational data retention, purge, legal hold, backup, and disaster-recovery requirements."),
    bullet("Entra group ownership, access reviews, privileged administration, emergency access, and credential rotation."),
    bullet("Whether optional live execution, email, OneDrive review, provisioning, or lifecycle controls are in scope."),
    bullet("Authority-to-operate, privacy impact assessment, records management, and change-control requirements."),
    callout("Not a compliance certification", "The architecture supports control implementation and evidence, but deployment does not automatically confer FedRAMP, CMMC, NIST, agency ATO, records-management, or privacy compliance. The customer must map the deployed configuration and operating procedures to its obligations.", C.coral),

    h("8. Prerequisites and customer decisions", 1, true),
    table(["Category", "Required before install"], [
      ["Azure Government", "Enabled subscription, approved region, resource group/naming/tags, Contributor, and permission to assign Azure roles."],
      ["Microsoft Entra", "Tenant ID, administrator who can create registrations and grant application consent, and groups for application-role assignment."],
      ["Microsoft 365", "SharePoint Administrator for evidence validation; representative pilot Teams; decision on available activity source."],
      ["Workstation", "PowerShell, Azure CLI, Node.js 24+, npm, access to GCC High endpoints, and secure AVD where Conditional Access requires it."],
      ["Security", "Ingress decision, approved data store, retention/logging policy, consent review, secrets/certificate policy, and deployment change window."],
      ["Operations", "Application owner, governance owner, incident contacts, cost center, monitoring recipients, and support model."],
    ], [2200, 7160]),
    h("Decisions to record", 2),
    step("Hosting subscription, resource group, approved Azure Government region, naming convention, tags, and cost center."),
    step("Pilot scope and authoritative sources for owners, channels, SharePoint exposure, activity, RCD, OneDrive, agents, and Copilot usage."),
    step("Entra groups for every application role and required segregation between operator, approver, and executor."),
    step("Retention for snapshots, findings, cases, audit history, feeds, telemetry, and backups."),
    step("Public authenticated ingress or private networking, plus DNS, firewall, proxy, and AVD dependencies."),
    step("Read-only pilot only, or which optional capabilities may enter dry run and later live operation."),

    h("9. Installation procedure", 1, true),
    h("Phase A: prepare and preflight", 2),
    step("Clone or obtain the reviewed customer package in the approved administration environment. Verify the expected branch/tag and integrity according to customer change control."),
    step("Open a dedicated PowerShell terminal. When multiple tenants are used on one workstation, isolate the Azure CLI profile before any az command."),
    code('$env:AZURE_CONFIG_DIR = "$HOME\\.azure-<customer>"\naz cloud set --name AzureUSGovernment\naz login --tenant <tenant-id>'),
    step("Run the offline inventory helper to identify eligible tenant/subscription combinations."),
    code(".\\scripts\\Get-TenantInventory.ps1"),
    step("Run preflight. It validates tools, cloud, subscription/tenant relationship, region, Azure permissions, Graph reachability, and Entra administrative capability without creating resources."),
    code(".\\scripts\\Install-Governance.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -Location <region> -PreflightOnly"),
    h("Phase B: deploy the read-only pilot", 2),
    step("Review the Bicep parameter values, proposed Graph permissions, role assignments, naming, and feature flags. Keep execution and live notifications disabled for the first deployment."),
    step("Run the installer from the target Azure cloud session."),
    code(".\\scripts\\Install-Governance.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -Location <region>"),
    step("If the Azure deployer cannot grant Graph consent, use -SkipGraphGrants and have an authorized Entra administrator grant only the printed permissions."),
    step("Assign customer-managed groups to Governance.Reader, Governance.Operator, Approver, Executor, Auditor, and Workspace.Owner as required. Enable Assignment required on the enterprise application."),
    h("Phase C: validate", 2),
    step("Run the deployment test as an assigned operator. This checks Easy Auth, app roles, protected APIs, dashboard routing, missing-route behavior, and one real read-only collection."),
    code(".\\scripts\\Test-Deployment.ps1 -TenantId <tenant-id>"),
    step("Use -SkipCollector for a non-mutating authentication, API, and dashboard check. Record the output in the customer's deployment evidence."),
    step("Open the dashboard, confirm role-appropriate access, and reconcile 5-10 pilot Teams against Teams and SharePoint administration views."),
    h("Phase D: harden and promote", 2),
    step("Configure monitoring alerts, telemetry sampling/daily cap, retention, budgets, resource locks, backup/export, and approved network controls."),
    step("Rotate the Easy Auth application credential before its one-year expiry by rerunning the installer. Verify the replacement before old installer-managed credentials are pruned."),
    step("Expand collection only after pilot acceptance. Enable optional capabilities separately, first in dry run, with a new permission and operational review."),
    h("Production readiness gate", 2),
    table(["Gate", "Evidence required before broader rollout"], [
      ["Data", "Pilot inventory reconciled; all Unknowns are understood, accepted, or assigned for resolution."],
      ["Access", "Role groups, separation of duties, emergency access, consent ownership, and access-review cadence approved."],
      ["Operations", "Monitoring, support, incident response, credential rotation, retention, backup/export, and recovery tested."],
      ["Security", "Network path, data handling, logging, change control, privacy, and applicable authorization evidence accepted."],
      ["Experience", "Representative owners, operators, approvers, and auditors complete their primary workflow successfully."],
      ["Commercial", "Customer scope, support responsibility, licensing, budget, and 7-/30-day Azure cost review agreed."],
    ], [2400, 6960]),

    h("10. Identity and permission model", 1, true),
    table(["Principal / role", "Scope", "What it can do"], [
      ["Dashboard sign-in app", "Customer tenant", "Authenticates users and defines API audience/app roles; it has no inventory application permissions."],
      ["Collector managed identity", "Approved Graph reads + deployment storage", "Reads inventory and approved reports; writes normalized governance state to customer storage."],
      ["Optional executor identity", "Only explicitly enabled write permissions", "Runs separately approved member, sharing, provisioning, lifecycle, or mail operations."],
      ["Governance.Reader", "Tenant-wide application data", "Reads workspaces, findings, cases, posture, and evidence."],
      ["Workspace.Owner", "Object-scoped tasks", "Reviews only assigned/owned workspace work; no tenant-wide read grant."],
      ["Governance.Operator", "Governance workflow", "Triages, assigns, manages suppressions, and can trigger a read-only collector run."],
      ["Approver", "Approval workflow", "Approves/rejects governed requests, exceptions, baselines, and lifecycle decisions."],
      ["Executor", "Approved execution workflow", "Moves approved work through execution and verification; does not create its own approval."],
      ["Auditor", "Tenant-wide application data", "Reads evidence and history without workflow mutation."],
    ], [2300, 2500, 4560]),
    callout("Permission review rule", "Grant only permissions exercised by the agreed pilot queries. Record endpoint-to-permission justification and remove any permission that cannot be demonstrated. Do not grant Directory.ReadWrite.All for the read-only release."),

    h("11. Pilot acceptance and test plan", 1, true),
    table(["Acceptance area", "Evidence of success"], [
      ["Authentication", "Anonymous access is refused; only assigned users enter; wrong-tenant and missing-role requests fail."],
      ["Inventory", "All pilot Teams appear exactly once; owners, membership, guests, channels, and archive state reconcile."],
      ["SharePoint correlation", "Parent, private-channel, and shared-channel sites resolve correctly where the source supports them."],
      ["Data quality", "Missing, stale, unsupported, or failed facts display Unknown with source and timestamp."],
      ["Policy", "Stable findings and cases do not duplicate; corrected facts resolve findings without overwriting case history."],
      ["Authorization", "Each role can perform only documented actions; stale ETags/versions return conflict without mutation."],
      ["Safety", "Collector is read-only; execution is dry run; no owner decision or acknowledgement silently changes Microsoft 365."],
      ["Reliability", "Collector failures are visible and do not replace the last good snapshot with empty data."],
      ["Operations", "Alerts, budget, retention, support ownership, credential rotation, and recovery procedures are documented."],
      ["Accessibility/UX", "Representative users complete their top workflow; keyboard, contrast, zoom, responsive layout, and plain language are reviewed."],
    ], [2300, 7060]),
    h("Reference evidence", 2),
    bullet("20/20 live deployment checks passed in the reference GCC High deployment."),
    bullet("170/170 repository tests passed with no failures or skips."),
    bullet("Eight workspaces collected, eight owner tasks created, and risk calculated for all eight."),
    bullet("The deployment used Node.js 24, a B1 Linux plan, StorageV2, Application Insights, Easy Auth, and one read-only collector identity."),

    h("12. Operations and support model", 1, true),
    table(["Cadence", "Operator activity"], [
      ["Every collector run", "Review run status, partial failures, source age, warning count, and new high-risk/open findings."],
      ["Daily", "Review failed authentication, Function errors, storage errors, stale sources, urgent cases, and notification failures."],
      ["Weekly", "Triage findings, owner escalations, drift alerts, exceptions, unresolved Unknowns, and unusual execution states."],
      ["Monthly", "Review role-group membership, Azure cost, capacity, telemetry volume, retention, audit sampling, and policy effectiveness."],
      ["Quarterly", "Access review, permissions review, disaster-recovery exercise, lifecycle evidence review, UX feedback, and roadmap prioritization."],
      ["Annually / before expiry", "Rotate Easy Auth credential and any customer certificates; review app registration ownership and emergency access."],
    ], [1900, 7460]),
    h("Incident priorities", 2),
    bullet("P1: suspected unauthorized access, unintended tenant mutation, credential exposure, or data exfiltration. Disable affected identity/feature, preserve evidence, and follow customer incident response."),
    bullet("P2: collection or dashboard outage, repeated failures, data integrity concern, or execution-uncertain state. Stop retries that could compound risk and reconcile manually."),
    bullet("P3: stale optional source, individual task problem, display defect, or non-critical mismatch. Track, triage, and correct without hiding the data-quality warning."),
    h("Backup and recovery", 2),
    bullet("Define retention and export/backup for Tables, evidence blobs, and telemetry according to customer policy."),
    bullet("Infrastructure can be recreated from Bicep, but operational state requires a customer-approved data protection strategy."),
    bullet("Document recovery time and recovery point objectives; test restore and role reassignment before production sign-off."),

    h("13. Cost and capacity planning", 1, true),
    p("The cost model is an engineering estimate, not a quote. It was last priced for Azure US Gov Virginia in October 2026. Reprice for the customer region and agreement before every proposal."),
    table(["Cost area", "Illustrative monthly amount"], [
      ["Linux App Service B1", "$23.07 at $0.0316/hour and 730 hours"],
      ["Azure Tables / Blob at pilot scale", "Less than $1 for under 1 GB and modest transactions"],
      ["Application telemetry at 0.5 GB", "Up to $1.44 before applicable free benefits"],
      ["Illustrative Azure total", "Approximately $24-$26"],
      ["Practical small-pilot planning range", "$25-$40"],
      ["P0v3 comparison range", "Approximately $70-$85 before optional services"],
    ], [4700, 4660]),
    h("Excluded or variable costs", 2),
    bullet("Microsoft 365 GCC High, SharePoint Advanced Management, Copilot, Copilot Studio, and other licensing."),
    bullet("Private endpoints, DNS, Firewall, Front Door, Key Vault, backup vaults, explicit Log Analytics workspace, premium support, and network transfer."),
    bullet("Implementation, security review, ATO evidence, operations, training, support, and custom integration."),
    h("Cost controls", 2),
    bullet("Keep B1 for a measured small pilot and resize only from CPU, memory, latency, and reliability evidence."),
    bullet("Set Application Insights sampling, retention, and daily cap; noisy telemetry can become the largest variable cost."),
    bullet("Tag resources, configure budgets/alerts, and replace estimates with Azure Cost Management actuals after 7 and 30 days."),
    bullet("Control collector frequency and history retention based on real decision and audit needs."),

    h("14. Limitations, risks, and roadmap", 1, true),
    table(["Topic", "Current boundary", "Recommended response"], [
      ["GCC High Teams activity", "Standard Graph Teams activity report is not supported.", "Validate a supported admin report, audit aggregate, or controlled import before claiming daily activity."],
      ["SharePoint / Purview facts", "Some facts have no suitable Graph API.", "Use an approved, validated evidence export with provenance and freshness."],
      ["OneDrive", "Bounded 100-item / 3-level permission scan; not a full content audit.", "Display truncation; use specialist tooling for comprehensive file audit."],
      ["Lifecycle legal/retention", "No automatic Purview hold connector.", "Require fresh explicit evidence; Unknown blocks delete."],
      ["Agent inventory", "Some preview/package APIs are not verified for GCC High.", "Use source-labeled catalog data and approved imports; validate new APIs before adding."],
      ["Live notifications", "Implemented but not exercised in the reference tenant.", "Pilot with a constrained sender mailbox and Exchange application access policy."],
      ["Execution", "Optional tenant-wide permissions carry material risk.", "Separate identity, explicit flags, dry run, two-person control, bounded action, and verification."],
      ["Availability", "Single B1 instance is a pilot posture.", "Define SLA/RTO/RPO and upgrade architecture based on customer requirements."],
    ], [2200, 3400, 3760]),
    h("Product roadmap priorities", 2),
    bullet("Role-first UX and consolidated work queue."),
    bullet("Automated accessibility testing and formal usability research with each persona."),
    bullet("CI/CD with signed artifacts, environment approvals, Bicep validation, and release evidence."),
    bullet("Customer-selectable retention, export, backup, and private-network patterns."),
    bullet("Tenant-validated activity, Purview, and agent connectors with explicit support matrices."),
    bullet("Measured scalability, resilience, and recovery objectives beyond pilot size."),

    h("15. Customer discovery and due diligence", 1, true),
    table(["Stakeholder", "Questions to resolve"], [
      ["Executive sponsor", "What decision should the pilot enable? What risk is unacceptable? What does success look like in 30/60/90 days?"],
      ["Governance", "Who owns policy, exceptions, escalations, and disposition? Which controls remain native Microsoft 365 controls?"],
      ["Security/privacy", "What data may be stored? Which network boundary, encryption, retention, audit, ATO, and privacy requirements apply?"],
      ["Entra administrator", "Who owns app registrations and consent? Which groups receive each role? What separation is mandatory?"],
      ["SharePoint/Teams", "Which authoritative reports and APIs work in this cloud? How will private/shared channel sites and RCD be reconciled?"],
      ["Operations", "Who receives alerts? What are support hours, incident paths, RTO/RPO, backup, patching, and credential-rotation expectations?"],
      ["FinOps", "Which cost center, budget, tags, forecast assumptions, and actual-cost review cadence apply?"],
      ["End users", "What is the shortest path to completing a review? Which terms confuse users? What accessibility accommodations are required?"],
    ], [2100, 7260]),
    h("Questions customers commonly ask", 2, true),
    table(["Question", "Answer"], [
      ["Does the app read file contents?", "No. The default governance inventory does not read file contents. Optional OneDrive/sharing review is bounded to item names and permission metadata."],
      ["Can it change our tenant?", "The reference pilot cannot. Optional write paths require a separate executor identity, additional consent, explicit flags, dry-run-to-live promotion, and verification."],
      ["Where is our data stored?", "In customer-owned Azure Storage in the selected environment, subject to the customer's configured region, retention, network, and protection controls."],
      ["What happens when data is missing?", "It is labeled Unknown with source/freshness context. Unknown never becomes healthy or inactive by assumption and can block high-risk actions."],
      ["Does it replace Purview, SAM, Entra governance, or admin centers?", "No. It orchestrates evidence and accountability across sources. Native controls and authoritative administration tools remain required."],
      ["What does it cost?", "A small B1 Azure pilot is estimated at $25-$40/month, excluding licensing, optional network/security services, support, and implementation."],
      ["Is it GCC High ready?", "The reference deployment was validated in Azure Government/GCC High. Each customer must still validate tenant-specific endpoints, licensing, permissions, reports, policy, and region."],
      ["How long does deployment take?", "A technically ready read-only deployment can be completed quickly, but customer approvals, consent, pilot-data validation, networking, and security acceptance usually determine the schedule."],
    ], [3000, 6360]),

    h("16. Handoff, RACI, and presentation checklist", 1, true),
    table(["Activity", "Customer", "Implementation team"], [
      ["Approve scope, policy, data, networking, and retention", "Accountable", "Consulted"],
      ["Provide subscription, administrators, and role groups", "Responsible / accountable", "Informed"],
      ["Deploy reviewed code and infrastructure", "Approves change", "Responsible"],
      ["Grant Graph/SharePoint consent", "Responsible / accountable", "Documents need"],
      ["Validate pilot data against authoritative sources", "Responsible", "Supports reconciliation"],
      ["Operate application, monitor, rotate credentials, and manage cost", "Responsible / accountable after handoff", "Trains / supports per agreement"],
      ["Approve optional live execution", "Responsible / accountable", "Implements only after approval"],
    ], [4100, 2800, 2460]),
    h("Handoff package", 2),
    bullet("Architecture and data-flow record, approved Bicep parameters, deployment output, and resource inventory."),
    bullet("App registrations, managed identities, Graph permissions, app-role groups, owners, expiry dates, and rotation procedure."),
    bullet("Validation evidence, pilot reconciliation, known limitations, accepted risks, and backlog."),
    bullet("Operations runbook, monitoring/alerts, retention, backup/recovery, incident contacts, support and escalation."),
    bullet("Cost estimate plus 7- and 30-day actuals, budget alerts, tags, and capacity assumptions."),
    h("Presentation readiness checklist", 2),
    bullet("State the customer problem and desired decision before showing technology."),
    bullet("Use Verified / Tenant validation required / Optional / Roadmap labels consistently."),
    bullet("Show read-only default, separation of duties, Unknown handling, and customer ownership early."),
    bullet("Quote cost as a planning estimate and identify exclusions."),
    bullet("Be explicit about GCC High activity limitations, bounded OneDrive review, and tenant-specific licensing."),
    bullet("End with a concrete read-only pilot proposal, owners, decisions, acceptance criteria, and next meeting."),

    h("Appendix A. Deployment troubleshooting", 1, true),
    table(["Symptom", "Likely cause / response"], [
      ["Sign-in callback returns 401", "Run Test-Deployment.ps1 -SkipCollector. Verify MICROSOFT_PROVIDER_AUTHENTICATION_SECRET exists; rerun installer to rotate/restore; sign out at /.auth/logout and retry with an assigned user."],
      ["Dashboard root shows stock Functions page", "Confirm AzureWebJobsDisableHomepage=true and dashboard route is exactly /."],
      ["API returns dashboard HTML", "A wildcard dashboard route is shadowing /api routes; deploy the explicit root-only route."],
      ["ZIP publish returned 202 but functions are absent", "Wait for a new successful Kudu deployment log and function discovery; retry transient SCM resets."],
      ["Collector cannot read a field", "Check source support in GCC High, permission-to-endpoint mapping, admin consent, licensing, and source freshness. Keep value Unknown until verified."],
      ["Azurite tests hang under OneDrive", "Launch Azurite from an isolated temporary working directory, as implemented by the test helper."],
    ], [3000, 6360]),
    h("Appendix B. Glossary", 1, true),
    table(["Term", "Meaning"], [
      ["Easy Auth", "App Service Authentication, used for customer-tenant sign-in before the request reaches the application."],
      ["GCC High", "Microsoft 365 US Government Community Cloud High, using US Government cloud endpoints."],
      ["RCD", "Restricted Content Discovery, a SharePoint capability used as one readiness evidence source."],
      ["SAM", "SharePoint Advanced Management."],
      ["Unknown", "A deliberate data-quality state for missing, stale, unsupported, or failed evidence; not equivalent to zero, false, healthy, or inactive."],
      ["Dry run", "Records what would happen without changing Microsoft 365."],
      ["Executor", "A separate role and optionally separate managed identity used only for approved tenant-changing actions."],
      ["Evidence feed", "A validated, timestamped, customer-approved file for facts unavailable through supported APIs."],
      ["Baseline", "An approver-recorded version of expected workspace state used to detect drift."],
    ], [2300, 7060]),
    h("Appendix C. Source documents", 1, true),
    bullet("README.md - implemented feature and behavior inventory."),
    bullet("CUSTOMER-DEPLOYMENT.md - customer architecture, prerequisites, install, validation, and production sequence."),
    bullet("docs/COST-AND-COMPONENTS.md - deployed components, pricing inputs, cost controls, and exclusions."),
    bullet("docs/GCCH-TEST-DEPLOYMENT-CASE-STUDY.md - sanitized reference deployment evidence and lessons."),
    bullet("infra/main.bicep - deployed Azure resource and security configuration."),
    bullet("scripts/Install-Governance.ps1 and scripts/Test-Deployment.ps1 - repeatable install and validation automation."),
  );

  const doc = new Document({
    creator: "Microsoft 365 Copilot Readiness project",
    title: "Microsoft 365 Copilot Readiness - Customer Deployment, Operations and Solution Guide",
    description: "Customer-facing solution, deployment, security, cost, operations, UX, and FAQ guide.",
    styles: {
      default: { document: { run: { font: "Aptos", size: 21, color: C.ink } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Aptos Display", size: 34, bold: true, color: C.charcoal }, paragraph: { spacing: { before: 260, after: 180 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Aptos Display", size: 27, bold: true, color: C.teal }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Aptos", size: 23, bold: true, color: C.ink }, paragraph: { spacing: { before: 160, after: 100 }, outlineLevel: 2 } },
      ],
    },
    numbering: { config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "o", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "-", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 980, hanging: 260 } } } },
      ] },
      { reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 620, hanging: 340 } } } }] },
    ] },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1440, bottom: 1080, left: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.teal, space: 4 } }, children: [new TextRun({ text: "MICROSOFT 365 COPILOT READINESS  |  CUSTOMER GUIDE", bold: true, color: C.gray, size: 16 })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Customer identifiers omitted  |  Page ", color: C.gray, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: C.gray, size: 16 })] })] }) },
      children,
    }],
  });
  fs.writeFileSync(DOCX_OUT, await removeUnusedDefaultNumbering(await Packer.toBuffer(doc)));
}

function createPptHelpers(pptx) {
  const titleFont = "Aptos Display";
  const bodyFont = "Aptos";
  const shape = pptx.ShapeType;
  function addFooter(slide, number, dark = false) {
    slide.addText("MICROSOFT 365 COPILOT READINESS", { x: 0.55, y: 5.28, w: 3.4, h: 0.16, fontFace: bodyFont, fontSize: 8, bold: true, color: dark ? "BFD0CD" : C.gray, margin: 0 });
    slide.addText(String(number).padStart(2, "0"), { x: 9.05, y: 5.25, w: 0.4, h: 0.18, fontFace: bodyFont, fontSize: 9, color: dark ? "BFD0CD" : C.gray, align: "right", margin: 0 });
  }
  function addTitle(slide, title, kicker, dark = false) {
    if (kicker) slide.addText(kicker.toUpperCase(), { x: 0.55, y: 0.32, w: 8.9, h: 0.2, fontFace: bodyFont, fontSize: 9, bold: true, color: dark ? C.teal2 : C.teal, charSpacing: 1.4, margin: 0 });
    slide.addText(title, { x: 0.55, y: 0.62, w: 8.85, h: 0.62, fontFace: titleFont, fontSize: 30, bold: true, color: dark ? C.white : C.charcoal, margin: 0, breakLine: false, fit: "shrink" });
  }
  function addNotes(slide, notes) {
    presentationNotes.push(notes);
  }
  function chip(slide, text, x, y, w, fill = C.mint, color = C.teal) {
    slide.addShape(shape.roundRect, { x, y, w, h: 0.32, rectRadius: 0.06, fill: { color: fill }, line: { color: fill } });
    slide.addText(text, { x: x + 0.08, y: y + 0.075, w: w - 0.16, h: 0.13, fontFace: bodyFont, fontSize: 8.5, bold: true, color, align: "center", margin: 0, fit: "shrink" });
  }
  function panel(slide, x, y, w, h, options = {}) {
    slide.addShape(shape.rect, { x, y, w, h, fill: { color: options.fill || C.white }, line: { color: options.line || C.line, width: 0.8 }, shadow: options.shadow ? { type: "outer", color: "000000", opacity: 0.08, blur: 4, angle: 45, offset: 1 } : undefined });
    if (options.accent) slide.addShape(shape.rect, { x, y, w: 0.06, h, fill: { color: options.accent }, line: { color: options.accent } });
  }
  function text(slide, value, x, y, w, h, options = {}) {
    slide.addText(value, { x, y, w, h, fontFace: options.fontFace || bodyFont, fontSize: options.fontSize || 14, bold: options.bold, color: options.color || C.ink, margin: options.margin ?? 0, valign: options.valign, align: options.align, breakLine: false, fit: options.fit || "shrink", italic: options.italic, bullet: options.bullet });
  }
  function stat(slide, value, label, x, y, color = C.teal) {
    text(slide, value, x, y, 1.65, 0.62, { fontFace: titleFont, fontSize: 35, bold: true, color });
    text(slide, label, x, y + 0.67, 1.65, 0.42, { fontSize: 10.5, color: C.gray });
  }
  return { shape, titleFont, bodyFont, addFooter, addTitle, addNotes, chip, panel, text, stat };
}

async function createPptx() {
  presentationNotes.length = 0;
  const pptx = new pptxgen();
  pptx.author = "Microsoft 365 Copilot Readiness project";
  pptx.company = "Customer-owned deployment";
  pptx.subject = "Customer solution, deployment, security, cost, UX, and pilot presentation";
  pptx.title = "Microsoft 365 Copilot Readiness";
  pptx.lang = "en-US";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "en-US" };
  pptx.layout = "LAYOUT_16x9";
  const H = createPptHelpers(pptx);
  let n = 0;
  const newSlide = (dark = false) => {
    const slide = pptx.addSlide();
    slide.background = { color: dark ? C.charcoal : C.paper };
    n += 1;
    H.addFooter(slide, n, dark);
    return slide;
  };

  {
    const s = newSlide(true);
    s.addShape(H.shape.rect, { x: 6.7, y: 0, w: 3.3, h: 5.625, fill: { color: C.teal }, line: { color: C.teal } });
    s.addShape(H.shape.ellipse, { x: 6.72, y: 0.72, w: 2.35, h: 2.35, fill: { color: C.teal, transparency: 100 }, line: { color: C.mint, width: 3, transparency: 35 } });
    s.addShape(H.shape.ellipse, { x: 7.05, y: 1.05, w: 1.69, h: 1.69, fill: { color: C.teal, transparency: 100 }, line: { color: C.white, width: 1.2, transparency: 65 } });
    s.addShape(H.shape.ellipse, { x: 7.34, y: 1.38, w: 1.05, h: 1.05, fill: { color: C.coral }, line: { color: C.coral } });
    H.text(s, "CUSTOMER BRIEFING", 0.58, 0.62, 4.2, 0.2, { fontSize: 10, bold: true, color: C.teal2 });
    H.text(s, "Microsoft 365\nCopilot Readiness", 0.58, 1.12, 5.65, 1.28, { fontFace: H.titleFont, fontSize: 39, bold: true, color: C.white });
    H.text(s, "Turn access, ownership, sharing, lifecycle, and evidence into an accountable readiness program.", 0.6, 2.7, 5.35, 0.75, { fontSize: 18, color: "DCE5E3" });
    H.chip(s, "GCC HIGH VALIDATED", 0.6, 3.82, 1.65, C.mint, C.teal);
    H.chip(s, "READ-ONLY DEFAULT", 2.38, 3.82, 1.65, "FCE8E5", C.coral);
    H.chip(s, "CUSTOMER OWNED", 4.16, 3.82, 1.55, "E8EDEF", C.charcoal);
    H.text(s, "Solution | Deployment | Security | Cost | User experience", 0.6, 4.48, 5.7, 0.32, { fontSize: 11, color: "BFD0CD" });
    H.addNotes(s, "Open with the customer problem, not the technology. The goal is to make Copilot readiness operational: know the estate, expose uncertainty, route accountable work, and preserve a safe separation between evidence and tenant-changing action. Ask: What decision should this pilot enable for your organization?");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Copilot increases the cost of unclear governance", "Why now");
    const items = [
      ["01", "Access", "Users may discover content they were already allowed to reach, including broad or stale sharing."],
      ["02", "Ownership", "Ownerless or under-owned workspaces have no accountable reviewer for access and lifecycle."],
      ["03", "Evidence", "Unsupported or stale sources can make a dashboard look healthier than reality."],
      ["04", "Action", "Unsafe automation can turn a finding into an outage, deletion, or compliance incident."],
    ];
    items.forEach(([num, title, body], i) => {
      const y = 1.48 + i * 0.86;
      H.text(s, num, 0.62, y, 0.45, 0.25, { fontSize: 11, bold: true, color: i === 3 ? C.coral : C.teal });
      H.text(s, title, 1.2, y - 0.05, 1.35, 0.27, { fontSize: 17, bold: true });
      H.text(s, body, 2.55, y - 0.05, 4.05, 0.45, { fontSize: 12.5, color: C.gray });
      s.addShape(H.shape.line, { x: 0.62, y: y + 0.55, w: 6.0, h: 0, line: { color: C.line, width: 0.8 } });
    });
    H.panel(s, 7.05, 1.4, 2.3, 3.25, { fill: C.charcoal });
    H.text(s, "The design response", 7.35, 1.72, 1.7, 0.28, { fontSize: 16, bold: true, color: C.white });
    [
      ["READ", "Read-only collection"],
      ["SHOW", "Unknown stays Unknown"],
      ["ROUTE", "Role-gated decisions"],
      ["SEPARATE", "Optional execution"],
    ].forEach(([label, body], index) => {
      const y = 2.2 + index * 0.54;
      H.text(s, label, 7.35, y, 0.62, 0.16, { fontSize: 8, bold: true, color: index === 3 ? C.coral : C.teal2 });
      H.text(s, body, 7.35, y + 0.2, 1.62, 0.2, { fontSize: 11.2, color: C.white });
    });
    H.addNotes(s, "Do not frame Copilot as creating all these risks. It often makes existing access and content hygiene more consequential. Emphasize that missing evidence is not interpreted as healthy and that the first deployment is read-only.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "One operational system for readiness work", "Solution overview");
    const stages = [
      ["COLLECT", "Groups, Teams, owners, members, channels, sites, approved evidence"],
      ["UNDERSTAND", "Normalize, source-label, score risk, evaluate versioned policy"],
      ["ROUTE", "Findings, cases, owner tasks, mover reviews, approvals"],
      ["VERIFY", "Audit, drift, source health, optional bounded execution checks"],
    ];
    stages.forEach(([label, body], i) => {
      const x = 0.6 + i * 2.28;
      s.addShape(H.shape.ellipse, { x: x + 0.62, y: 1.48, w: 0.66, h: 0.66, fill: { color: i === 3 ? C.coral : C.teal }, line: { color: C.white, width: 2 } });
      H.text(s, String(i + 1), x + 0.83, 1.67, 0.24, 0.2, { fontSize: 15, bold: true, color: C.white, align: "center" });
      if (i < 3) s.addShape(H.shape.chevron, { x: x + 1.51, y: 1.67, w: 0.42, h: 0.26, fill: { color: C.line }, line: { color: C.line } });
      H.text(s, label, x, 2.38, 1.9, 0.25, { fontSize: 13, bold: true, color: C.teal, align: "center" });
      H.text(s, body, x, 2.82, 1.9, 1.05, { fontSize: 11.5, color: C.gray, align: "center", valign: "top" });
    });
    H.panel(s, 0.6, 4.35, 8.75, 0.55, { fill: C.mint, line: C.mint });
    H.text(s, "Customer-owned Azure resources  |  Server-side authorization  |  No tenant-wide token in browser code", 0.9, 4.53, 8.15, 0.18, { fontSize: 11.5, bold: true, color: C.teal, align: "center" });
    H.addNotes(s, "Walk left to right. Collection is not the end product; accountable work is. The service retains source timestamps, policy versions, and audit history so a decision can be explained later.");
  }

  {
    const s = newSlide(true);
    H.addTitle(s, "The reference deployment is working evidence", "Validated outcome", true);
    H.stat(s, "20/20", "live deployment checks passed", 0.68, 1.55, C.teal2);
    H.stat(s, "170/170", "repository tests passed", 2.85, 1.55, C.teal2);
    H.stat(s, "8", "workspaces collected", 5.15, 1.55, C.coral);
    H.stat(s, "8", "owner tasks created", 7.35, 1.55, C.coral);
    H.panel(s, 0.65, 3.25, 8.7, 1.25, { fill: C.charcoal2, line: "4E585B" });
    H.text(s, "Reference posture", 0.95, 3.58, 1.55, 0.24, { fontSize: 13, bold: true, color: C.white });
    H.text(s, "Node.js 24 · B1 Linux · StorageV2 · Application Insights · Easy Auth · one read-only collector identity · no executor identity · tenant-write execution off", 2.55, 3.47, 6.35, 0.55, { fontSize: 13, color: "DCE5E3" });
    H.addNotes(s, "These are implementation facts from the sanitized GCC High case study. They prove the deployment path and read-only collection, not universal customer readiness. Every target tenant still needs its own permission, source, licensing, network, and acceptance validation.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "The interface is organized around accountable work", "Product experience");
    if (fs.existsSync(DASHBOARD_IMAGE) && process.env.SKIP_DASHBOARD_IMAGE !== "1") {
      s.addImage({ path: DASHBOARD_IMAGE, x: 0.45, y: 1.32, w: 6.38, h: 3.59, altText: "Sanitized live My Workspaces governance dashboard" });
      s.addShape(H.shape.rect, { x: 0.45, y: 1.32, w: 6.38, h: 3.59, fill: { color: C.white, transparency: 100 }, line: { color: C.line, width: 1 } });
    }
    const points = [
      ["Role-specific workflow", "Owners see assigned review work and explicit safe outcomes."],
      ["Evidence before action", "Risk, source state, history, and approval context travel with the decision."],
      ["Honest states", "Record-only, simulated, approved, executed, verified, failed, and uncertain are distinct."],
    ];
    points.forEach(([title, body], i) => {
      const y = 1.45 + i * 1.0;
      H.panel(s, 7.1, y, 2.38, 0.82, { fill: C.white, accent: i === 2 ? C.coral : C.teal });
      H.text(s, title, 7.37, y + 0.15, 1.83, 0.2, { fontSize: 12.4, bold: true });
      H.text(s, body, 7.37, y + 0.4, 1.83, 0.28, { fontSize: 9.2, color: C.gray });
    });
    H.text(s, "Live reference view, sanitized test data", 0.48, 4.98, 4.0, 0.17, { fontSize: 9, italic: true, color: C.gray });
    H.addNotes(s, "Demonstrate the application as an operational workspace, not as a glossy reporting portal. This screenshot is from the validated deployment and contains only synthetic SAMTest data. Explain that the UX roadmap improves scan hierarchy and role-specific entry points.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Nine views cover program, governance, and action", "Feature map");
    const views = [
      ["Program Plan", "rollout gate, blockers, phase health"], ["Tenant Governance", "estate and exposure overview"], ["My Workspaces", "owner renewals and mover reviews"],
      ["Findings", "evidence, cases, transitions"], ["OneDrive", "metadata and bounded sharing review"], ["Posture", "risk, sources, trend, drift"],
      ["Requests", "catalog, approval, provisioning"], ["AI and Agents", "Copilot seats/adoption and agents"], ["Program Tasks", "42-task execution plan"],
    ];
    views.forEach(([title, body], i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 0.62 + col * 3.02, y = 1.42 + row * 1.12;
      H.panel(s, x, y, 2.68, 0.88, { fill: C.white, accent: i === 3 || i === 5 ? C.coral : C.teal });
      H.text(s, title, x + 0.25, y + 0.16, 2.14, 0.2, { fontSize: 14, bold: true });
      H.text(s, body, x + 0.25, y + 0.43, 2.1, 0.27, { fontSize: 9.8, color: C.gray });
    });
    H.addNotes(s, "Use this as a navigation map. Avoid deep-diving every view unless the audience asks. For owners, focus on My Workspaces; for governance, Findings and Posture; for sponsors, Program Plan; for service management, Program Tasks.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Architecture keeps user access, collection, and execution separate", "Technical design");
    const boxes = [
      [0.62, 1.55, 1.85, 0.85, C.white, "Authorized users", "Entra sign-in + app roles"],
      [3.05, 1.3, 2.2, 1.35, C.mint, "Azure Function App", "Dashboard · API · collector · workflows"],
      [6.05, 1.0, 1.75, 0.9, C.white, "Microsoft Graph", "GCC High read APIs"],
      [6.05, 2.15, 1.75, 0.9, C.white, "Evidence feeds", "SharePoint · Purview · activity"],
      [3.05, 3.5, 2.2, 0.95, C.white, "Azure Storage", "Tables · Blob · operational history"],
      [7.95, 3.5, 1.4, 0.95, "FCE8E5", "Optional executor", "Separate identity"],
    ];
    boxes.forEach(([x, y, w, hh, fill, title, body]) => {
      H.panel(s, x, y, w, hh, { fill, line: fill === C.mint ? C.teal : C.line, shadow: true });
      H.text(s, title, x + 0.17, y + 0.18, w - 0.34, 0.22, { fontSize: 13, bold: true, align: "center" });
      H.text(s, body, x + 0.17, y + 0.47, w - 0.34, 0.28, { fontSize: 9.5, color: C.gray, align: "center" });
    });
    [[2.47,1.86,0.58,0],[5.25,1.45,0.8,0.25],[5.25,2.05,0.8,0.55],[4.14,2.65,0,0.85],[7.8,3.95,0.15,0]].forEach(([x,y,w,hh]) => s.addShape(H.shape.line, { x, y, w, h: hh, line: { color: C.teal, width: 2.25, beginArrowType: "none", endArrowType: "triangle" } }));
    H.text(s, "Read path", 5.42, 1.19, 0.6, 0.16, { fontSize: 8, bold: true, color: C.teal });
    H.text(s, "Write path only when explicitly enabled", 6.08, 4.62, 3.25, 0.2, { fontSize: 9, bold: true, color: C.coral, align: "right" });
    H.addNotes(s, "This is the key security slide. Browser code never receives the collector credential. The sign-in application has no tenant inventory application permissions. The optional executor is absent from the reference deployment and should be treated as a separate change with separate consent.");
  }

  {
    const s = newSlide(true);
    H.addTitle(s, "Safety is a workflow, not a toggle", "Security model", true);
    const controls = [
      ["LEAST PRIVILEGE", "Reviewed read-only collector permissions"],
      ["SEPARATION", "Reader · owner · operator · approver · executor · auditor"],
      ["FAIL CLOSED", "Unknown evidence cannot masquerade as healthy"],
      ["VERIFY", "Re-read before and after bounded optional actions"],
    ];
    controls.forEach(([label, body], i) => {
      const x = 0.65 + (i % 2) * 4.45, y = 1.45 + Math.floor(i / 2) * 1.42;
      H.panel(s, x, y, 4.02, 1.08, { fill: C.charcoal2, line: "4E585B", accent: i === 2 ? C.coral : C.teal2 });
      H.text(s, label, x + 0.32, y + 0.22, 3.35, 0.2, { fontSize: 11, bold: true, color: i === 2 ? C.coral : C.teal2 });
      H.text(s, body, x + 0.32, y + 0.52, 3.35, 0.32, { fontSize: 14, color: C.white });
    });
    H.panel(s, 0.65, 4.35, 8.47, 0.52, { fill: "FCE8E5", line: "FCE8E5" });
    H.text(s, "Dry run is the default. Customer-owned consent, roles, data, logs, and operating decisions remain in the customer environment.", 0.92, 4.52, 7.9, 0.18, { fontSize: 11, bold: true, color: C.coral, align: "center" });
    H.addNotes(s, "Distinguish application controls from compliance claims. This design supports least privilege and auditability, but the customer must map configuration and operations to its NIST, CMMC, FedRAMP, agency ATO, privacy, and records obligations.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Missing evidence is visible by design", "Data and privacy");
    const funnel = [
      [0.75, 1.38, 8.5, "SOURCE", "Graph · SharePoint export · approved report · controlled evidence feed", C.charcoal],
      [1.35, 2.1, 7.3, "PROVENANCE", "source · collected-at · source timestamp · freshness · warning", C.teal],
      [1.95, 2.82, 6.1, "NORMALIZED FACT", "known value or explicit Unknown", C.teal2],
      [2.55, 3.54, 4.9, "DECISION", "policy · risk · task · approval", C.coral],
    ];
    funnel.forEach(([x,y,w,label,body,color]) => {
      s.addShape(H.shape.chevron, { x, y, w, h: 0.56, fill: { color }, line: { color } });
      H.text(s, label, x + 0.25, y + 0.13, 1.2, 0.17, { fontSize: 9, bold: true, color: C.white });
      H.text(s, body, x + 1.52, y + 0.11, w - 1.9, 0.2, { fontSize: 10.5, color: C.white, align: "center" });
    });
    H.text(s, "OneDrive content is not read. Optional review uses bounded item names and permission metadata.", 1.1, 4.52, 7.8, 0.3, { fontSize: 12, bold: true, color: C.gray, align: "center" });
    H.addNotes(s, "Explain the semantic importance of Unknown. Missing activity is not inactivity; missing exposure is not safety. Also state the OneDrive boundary clearly: this is not a tenant-wide content inspection or a replacement for specialized data security tools.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "A compact, supportable Microsoft stack", "Technology");
    const layers = [
      ["EXPERIENCE", "HTML · CSS · JavaScript", C.charcoal],
      ["APPLICATION", "Azure Functions v4 · Node.js 24 · ESM", C.teal],
      ["IDENTITY", "Entra ID · Easy Auth · managed identity · app roles", C.teal2],
      ["DATA + TELEMETRY", "Azure Tables · Blob Storage · Application Insights", C.coral],
      ["DELIVERY", "Bicep · PowerShell · Azure CLI · Node test runner · Azurite", C.charcoal2],
    ];
    layers.forEach(([label, detail, color], i) => {
      const y = 1.38 + i * 0.7;
      s.addShape(H.shape.rect, { x: 0.8 + i * 0.18, y, w: 8.35 - i * 0.36, h: 0.5, fill: { color }, line: { color } });
      H.text(s, label, 1.05 + i * 0.18, y + 0.13, 1.55, 0.16, { fontSize: 9, bold: true, color: C.white });
      H.text(s, detail, 2.45 + i * 0.18, y + 0.11, 5.95 - i * 0.36, 0.2, { fontSize: 11.5, color: C.white, align: "center" });
    });
    H.text(s, "Government endpoints are explicit: .us authorities, Graph, App Service, ARM, and SharePoint.", 1.05, 4.98, 7.9, 0.2, { fontSize: 10.5, italic: true, color: C.gray, align: "center" });
    H.addNotes(s, "The application deliberately avoids a large platform footprint. The Function App serves both UI and API and runs the collector. Customer policy may add Key Vault, private endpoints, Log Analytics, backup, firewall, or premium compute.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Installation is scripted; readiness is still a customer decision", "Deployment");
    const phases = [
      ["1", "DISCOVER", "subscription · region · pilot · data sources"],
      ["2", "PREFLIGHT", "tools · cloud · roles · tenant · Graph"],
      ["3", "DEPLOY", "Bicep · app · identities · consent · code"],
      ["4", "PROVE", "routes · roles · collector · reconciliation"],
      ["5", "PROMOTE", "monitoring · retention · hardening · handoff"],
    ];
    phases.forEach(([num,label,body], i) => {
      const x = 0.57 + i * 1.86;
      s.addShape(H.shape.hexagon, { x: x + 0.43, y: 1.45, w: 0.74, h: 0.68, fill: { color: i === 4 ? C.coral : C.teal }, line: { color: C.white, width: 1.2 } });
      H.text(s, num, x + 0.66, 1.67, 0.27, 0.2, { fontSize: 14, bold: true, color: C.white, align: "center" });
      if (i < 4) s.addShape(H.shape.line, { x: x + 1.24, y: 1.79, w: 0.55, h: 0, line: { color: C.line, width: 2, endArrowType: "triangle" } });
      H.text(s, label, x, 2.42, 1.6, 0.22, { fontSize: 12, bold: true, color: C.teal, align: "center" });
      H.text(s, body, x, 2.8, 1.6, 0.85, { fontSize: 10.5, color: C.gray, align: "center" });
    });
    H.panel(s, 0.75, 4.25, 8.5, 0.62, { fill: C.charcoal, line: C.charcoal });
    H.text(s, ".\\scripts\\Install-Governance.ps1 ... -PreflightOnly    →    Install    →    .\\scripts\\Test-Deployment.ps1", 1.08, 4.47, 7.85, 0.18, { fontFace: "Consolas", fontSize: 10.2, color: C.white, align: "center" });
    H.addNotes(s, "The code deployment can be fast; customer approvals and evidence validation usually set the schedule. Preflight is non-mutating. The full test includes one operator-authorized read-only collection. Use SkipCollector when testing only authentication, routes, and dashboard behavior.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Start with a representative 5-10 Team pilot", "Pilot plan");
    const weeks = [
      ["WEEK 0", "Decide", "scope · owners · security · sources"],
      ["WEEK 1", "Deploy", "preflight · install · consent · roles"],
      ["WEEK 2", "Reconcile", "Teams · sites · findings · Unknowns"],
      ["WEEK 3", "Operate", "owner workflow · triage · monitoring"],
      ["WEEK 4", "Decide", "accept · remediate · scale · stop"],
    ];
    weeks.forEach(([week, action, detail], i) => {
      const x = 0.62 + i * 1.82;
      s.addShape(H.shape.line, { x: x + 0.46, y: 1.75, w: i < 4 ? 1.35 : 0, h: 0, line: { color: C.line, width: 3 } });
      s.addShape(H.shape.ellipse, { x: x + 0.25, y: 1.53, w: 0.44, h: 0.44, fill: { color: i === 4 ? C.coral : C.teal }, line: { color: C.white, width: 1.5 } });
      H.text(s, week, x, 2.2, 1.1, 0.18, { fontSize: 9, bold: true, color: C.teal, align: "center" });
      H.text(s, action, x - 0.18, 2.55, 1.45, 0.25, { fontSize: 15, bold: true, align: "center" });
      H.text(s, detail, x - 0.18, 2.95, 1.45, 0.75, { fontSize: 10.5, color: C.gray, align: "center" });
    });
    H.panel(s, 0.75, 4.25, 8.5, 0.55, { fill: C.mint, line: C.mint });
    H.text(s, "Exit evidence: reconciled inventory · role tests · source quality · operating owner · accepted risks · measured cost", 1.0, 4.43, 8.0, 0.17, { fontSize: 10.5, bold: true, color: C.teal, align: "center" });
    H.addNotes(s, "This is an illustrative sequence, not a fixed promise. Networking, consent boards, security assessment, AVD access, or unavailable data sources can extend the schedule. The pilot should end with a decision, not merely a demo.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Success is measured by fidelity, safety, and adoption", "Acceptance");
    const measures = [
      ["FIDELITY", "Pilot Teams appear once; owners, members, guests, channels, and sites reconcile."],
      ["HONESTY", "Missing or stale facts remain Unknown with source and timestamp."],
      ["CONTROL", "Unauthorized roles fail; stale versions cannot overwrite decisions."],
      ["SAFETY", "Collector remains read-only; no workflow decision silently changes the tenant."],
      ["OPERABILITY", "Alerts, retention, support, rotation, recovery, and cost ownership are assigned."],
      ["USABILITY", "Each persona completes its primary workflow with accessible, understandable states."],
    ];
    measures.forEach(([label,body], i) => {
      const col = i % 2, row = Math.floor(i / 2), x = 0.65 + col * 4.45, y = 1.35 + row * 1.12;
      H.panel(s, x, y, 4.05, 0.88, { fill: C.white, accent: i === 3 ? C.coral : C.teal });
      H.text(s, label, x + 0.3, y + 0.17, 1.15, 0.18, { fontSize: 9.5, bold: true, color: i === 3 ? C.coral : C.teal });
      H.text(s, body, x + 1.4, y + 0.12, 2.3, 0.5, { fontSize: 10.3, color: C.gray });
    });
    H.addNotes(s, "Agree acceptance criteria before installation. Add customer-specific security and accessibility requirements. For usability, test actual owners, operators, and approvers rather than relying only on administrators who know the system.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "The pilot Azure footprint is deliberately small", "Cost model");
    const costBars = [
      ["B1 compute", 23.07, 3.85],
      ["Storage", 0.8, 0.14],
      ["Telemetry (0.5 GB)", 1.44, 0.24],
    ];
    costBars.forEach(([label, value, width], index) => {
      const y = 1.55 + index * 0.82;
      H.text(s, label, 0.72, y, 1.55, 0.2, { fontSize: 11, bold: true, color: C.gray });
      s.addShape(H.shape.rect, { x: 2.3, y: y - 0.03, w: 3.95, h: 0.3, fill: { color: "E3E9E8" }, line: { color: "E3E9E8" } });
      s.addShape(H.shape.rect, { x: 2.3, y: y - 0.03, w: width, h: 0.3, fill: { color: C.teal }, line: { color: C.teal } });
      H.text(s, `$${value}`, 5.45, y, 0.72, 0.2, { fontSize: 11, bold: true, color: C.ink, align: "right" });
    });
    H.text(s, "Illustrative monthly USD", 2.3, 4.02, 3.85, 0.16, { fontSize: 9, italic: true, color: C.gray, align: "center" });
    H.panel(s, 6.35, 1.42, 2.85, 1.22, { fill: C.charcoal });
    H.text(s, "$25-$40", 6.65, 1.72, 2.25, 0.43, { fontFace: H.titleFont, fontSize: 32, bold: true, color: C.white, align: "center" });
    H.text(s, "small B1 pilot planning range", 6.65, 2.2, 2.25, 0.18, { fontSize: 10, color: "DCE5E3", align: "center" });
    H.panel(s, 6.35, 2.9, 2.85, 1.22, { fill: "FCE8E5", line: "FCE8E5" });
    H.text(s, "Excluded", 6.67, 3.19, 2.15, 0.2, { fontSize: 13, bold: true, color: C.coral, align: "center" });
    H.text(s, "M365 licensing · private network · support · implementation", 6.7, 3.51, 2.1, 0.35, { fontSize: 9.8, color: C.gray, align: "center" });
    H.text(s, "Engineering estimate, not a quote. Reprice by region and agreement; replace with 7- and 30-day actuals.", 0.86, 4.55, 8.2, 0.25, { fontSize: 10.5, italic: true, color: C.gray, align: "center" });
    H.addNotes(s, "The illustrative base is about $24-$26 per month using October 2026 public US Gov Virginia retail inputs. Telemetry, networking, premium compute, backup, support, and licensing can materially change the total. Never present the estimate as a fixed customer quote.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Operations turn a deployment into a service", "Run model");
    const cadence = [
      ["RUN", "Collector status · partial failures · source freshness"],
      ["DAILY", "Auth · Functions · storage · urgent findings"],
      ["WEEKLY", "Triage · owner escalation · drift · Unknowns"],
      ["MONTHLY", "Roles · cost · telemetry · retention · policy"],
      ["QUARTERLY", "Access review · DR test · permissions · UX"],
    ];
    cadence.forEach(([label,body], i) => {
      const y = 1.35 + i * 0.7;
      H.text(s, label, 0.7, y + 0.09, 1.05, 0.18, { fontSize: 10, bold: true, color: i === 0 ? C.coral : C.teal });
      s.addShape(H.shape.line, { x: 1.82, y: y + 0.19, w: 0.45, h: 0, line: { color: C.line, width: 1.5 } });
      H.panel(s, 2.35, y, 6.65, 0.43, { fill: i % 2 ? C.white : C.mint, line: i % 2 ? C.line : C.mint });
      H.text(s, body, 2.62, y + 0.12, 6.1, 0.15, { fontSize: 10.8, color: C.ink });
    });
    H.text(s, "Infrastructure is recreatable; operational state still needs retention, export/backup, and tested recovery.", 1.0, 4.95, 8.0, 0.2, { fontSize: 10.5, bold: true, color: C.gray, align: "center" });
    H.addNotes(s, "Confirm who owns each cadence before handoff. Ask for support hours, incident severity definitions, RTO/RPO, retention, export/backup, credential rotation, and cost management. A Bicep template is not a backup of operational records.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "User experience improvements are part of readiness", "UX roadmap");
    const priorities = [
      ["P0", "Find the work", "Role-specific home · consolidated queue · freshness · strong loading/error/empty states"],
      ["P1", "Finish the work", "Guided review · consistent status language · saved views · accessible charts"],
      ["P2", "Improve the system", "Feedback · privacy-aware analytics · preferences · customer theming"],
    ];
    priorities.forEach(([pnum,title,body], i) => {
      const y = 1.36 + i * 1.05;
      H.text(s, pnum, 0.72, y + 0.17, 0.55, 0.25, { fontSize: 18, bold: true, color: i === 0 ? C.coral : C.teal });
      H.panel(s, 1.43, y, 7.72, 0.78, { fill: C.white, accent: i === 0 ? C.coral : C.teal });
      H.text(s, title, 1.72, y + 0.17, 1.75, 0.22, { fontSize: 15, bold: true });
      H.text(s, body, 3.35, y + 0.13, 5.4, 0.38, { fontSize: 10.7, color: C.gray });
    });
    H.panel(s, 0.72, 4.65, 8.43, 0.35, { fill: C.charcoal, line: C.charcoal });
    H.text(s, "Measure: time to first action · completion rate · completion latency · accessibility findings · support demand", 0.95, 4.75, 7.95, 0.14, { fontSize: 9.5, color: C.white, align: "center" });
    H.addNotes(s, "Be candid: the current dashboard is operational and feature-rich, but dense. The most valuable design work is role-first prioritization, clearer scan hierarchy, and responsive task completion. Do not optimize for decorative polish ahead of decision clarity and accessibility.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Boundaries are explicit so expectations stay credible", "Risks and limitations");
    const risks = [
      ["GCC HIGH ACTIVITY", "Validate a supported report, audit aggregate, or controlled import."],
      ["ONEDRIVE SCOPE", "Bounded permission metadata review, not a full content audit."],
      ["PURVIEW EVIDENCE", "No automatic legal-hold connector; Unknown blocks delete."],
      ["AGENT APIS", "Some preview/package APIs are not verified for GCC High."],
      ["LIVE EXECUTION", "Adds tenant-wide permissions and must be a separate approved change."],
      ["PILOT AVAILABILITY", "Single B1 posture; SLA, scale, and DR must match customer needs."],
    ];
    risks.forEach(([title,body], i) => {
      const col = i % 3, row = Math.floor(i / 3), x = 0.62 + col * 3.02, y = 1.42 + row * 1.45;
      H.panel(s, x, y, 2.68, 1.12, { fill: i < 3 ? "FCE8E5" : C.white, line: i < 3 ? "F6C9C5" : C.line });
      H.text(s, title, x + 0.22, y + 0.2, 2.2, 0.2, { fontSize: 9.5, bold: true, color: C.coral });
      H.text(s, body, x + 0.22, y + 0.5, 2.2, 0.42, { fontSize: 10.2, color: C.gray });
    });
    H.text(s, "A limitation stated early becomes a design decision; a limitation hidden becomes a delivery risk.", 0.9, 4.62, 8.2, 0.28, { fontSize: 14, bold: true, color: C.teal, align: "center" });
    H.addNotes(s, "Use this slide proactively. It builds trust and prevents accidental overclaiming. Ask which limitations are blockers for the customer's pilot and which can be accepted with an explicit operating procedure.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Five customer decisions unlock the pilot", "Customer responsibilities");
    const decisions = [
      ["01", "Where will it run?", "Subscription · region · network · data store"],
      ["02", "Who can approve?", "Entra admin · SharePoint admin · change authority"],
      ["03", "Who can use it?", "Role groups · separation of duties · access review"],
      ["04", "What evidence is authoritative?", "Activity · exposure · RCD · OneDrive · agents"],
      ["05", "How will it be operated?", "Retention · support · incident · DR · cost"],
    ];
    decisions.forEach(([num,title,body], i) => {
      const y = 1.25 + i * 0.72;
      H.text(s, num, 0.72, y + 0.08, 0.52, 0.22, { fontSize: 14, bold: true, color: i === 4 ? C.coral : C.teal });
      H.text(s, title, 1.42, y + 0.04, 2.7, 0.22, { fontSize: 14, bold: true });
      H.text(s, body, 4.12, y + 0.05, 4.85, 0.25, { fontSize: 11.5, color: C.gray });
      s.addShape(H.shape.line, { x: 1.42, y: y + 0.48, w: 7.55, h: 0, line: { color: C.line, width: 0.7 } });
    });
    H.addNotes(s, "These decisions are more important than parameter entry. Capture named owners and due dates. If different people hold Azure and Entra authority, the installer supports skipping Graph grants so consent can be completed by the correct administrator.");
  }

  {
    const s = newSlide(true);
    H.addTitle(s, "Proposed next step: a controlled read-only pilot", "Recommendation", true);
    H.text(s, "5-10", 0.72, 1.4, 1.45, 0.7, { fontFace: H.titleFont, fontSize: 44, bold: true, color: C.teal2 });
    H.text(s, "representative Teams", 0.74, 2.12, 1.75, 0.33, { fontSize: 12, color: "DCE5E3" });
    const actions = [
      ["Confirm", "scope, owners, cloud, sources, and security decisions"],
      ["Deploy", "read-only collector and authenticated dashboard"],
      ["Reconcile", "against authoritative Teams and SharePoint views"],
      ["Decide", "accept, remediate, scale, or stop with evidence"],
    ];
    actions.forEach(([title,body], i) => {
      const y = 1.3 + i * 0.82;
      H.panel(s, 3.0, y, 6.05, 0.58, { fill: C.charcoal2, line: "4E585B", accent: i === 3 ? C.coral : C.teal2 });
      H.text(s, title, 3.3, y + 0.16, 1.15, 0.19, { fontSize: 13, bold: true, color: i === 3 ? C.coral : C.teal2 });
      H.text(s, body, 4.55, y + 0.15, 4.15, 0.22, { fontSize: 11.2, color: C.white });
    });
    H.text(s, "Decision requested", 0.72, 4.25, 1.55, 0.2, { fontSize: 10, bold: true, color: C.coral });
    H.text(s, "Approve discovery and preflight; identify customer technical, governance, security, and operations owners.", 2.25, 4.2, 6.8, 0.32, { fontSize: 13, color: C.white });
    H.addNotes(s, "Close with a specific decision. Do not ask for permission to deploy broadly. Ask to approve discovery and non-mutating preflight, name the four customer owners, and select the representative pilot workspaces and evidence sources.");
  }

  {
    const s = newSlide();
    H.addTitle(s, "Questions to invite", "Discussion guide");
    const qs = [
      ["BUSINESS", "Which readiness decision is blocked today?"],
      ["GOVERNANCE", "Who owns policy, exceptions, and unresolved Unknowns?"],
      ["SECURITY", "Which data, network, consent, and ATO controls apply?"],
      ["OPERATIONS", "Who monitors, supports, restores, rotates, and pays?"],
      ["EXPERIENCE", "Can each persona identify and complete their next task?"],
      ["SCALE", "What evidence would justify tenant-wide rollout?"],
    ];
    qs.forEach(([label,body], i) => {
      const col = i % 2, row = Math.floor(i / 2), x = 0.75 + col * 4.35, y = 1.3 + row * 1.08;
      H.text(s, label, x, y, 1.15, 0.19, { fontSize: 9.5, bold: true, color: i === 4 ? C.coral : C.teal });
      H.text(s, body, x + 1.25, y - 0.03, 2.75, 0.52, { fontSize: 13, bold: true, color: C.ink });
    });
    H.panel(s, 0.75, 4.63, 8.5, 0.38, { fill: C.mint, line: C.mint });
    H.text(s, "Detailed install steps, security decisions, FAQ, RACI, cost assumptions, troubleshooting, and glossary are in the companion customer guide.", 1.0, 4.75, 8.0, 0.14, { fontSize: 9.5, color: C.teal, align: "center" });
    H.addNotes(s, "Use the companion Word guide for detailed answers. If a question depends on tenant licensing, API availability, customer policy, or pricing, say that it requires validation rather than guessing. Capture unanswered questions, owner, and due date.");
  }

  const maxSlides = Number.parseInt(process.env.MAX_PPTX_SLIDES || "", 10);
  if (Number.isFinite(maxSlides) && maxSlides > 0) {
    pptx._slides = pptx._slides.slice(0, maxSlides);
    presentationNotes.splice(maxSlides);
  }
  await pptx.writeFile({ fileName: PPTX_OUT });
  fs.writeFileSync(NOTES_OUT, JSON.stringify(presentationNotes, null, 2));
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  await createDocx();
  await createPptx();
  console.log(`Created ${DOCX_OUT}`);
  console.log(`Created ${PPTX_OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});