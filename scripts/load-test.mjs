import { writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...value] = item.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const profiles = {
  pilot: { tenantWorkspaces: 'up to 250', concurrency: 5, requests: 100, p95Ms: 2000, maxErrorRate: 0.01 },
  department: { tenantWorkspaces: '251-2,500', concurrency: 15, requests: 600, p95Ms: 2500, maxErrorRate: 0.01 },
  enterprise: { tenantWorkspaces: '2,501-10,000', concurrency: 30, requests: 1800, p95Ms: 3000, maxErrorRate: 0.01 }
};
const profileName = args.profile || 'pilot';
const profile = profiles[profileName];
if (!profile) throw new Error(`Unknown profile ${profileName}`);
if (args['dry-run'] === 'true') {
  console.log(JSON.stringify({ profile: profileName, ...profile }, null, 2));
  process.exit(0);
}
if (!args.url || !process.env.SAM_ACCESS_TOKEN) throw new Error('--url and SAM_ACCESS_TOKEN are required');

const routes = ['/api/policies', '/api/workspaces', '/api/findings', '/api/cases', '/api/posture', '/api/sources', '/api/owner/tasks?scope=all'];
const durations = [];
const statuses = {};
let cursor = 0;
const started = Date.now();
async function worker() {
  while (true) {
    const request = cursor++;
    if (request >= profile.requests) return;
    const route = routes[request % routes.length];
    const before = performance.now();
    try {
      const response = await fetch(`${args.url.replace(/\/$/, '')}${route}`, { headers: { Authorization: `Bearer ${process.env.SAM_ACCESS_TOKEN}` } });
      statuses[response.status] = (statuses[response.status] || 0) + 1;
      await response.arrayBuffer();
    } catch {
      statuses.network = (statuses.network || 0) + 1;
    }
    durations.push(performance.now() - before);
  }
}
await Promise.all(Array.from({ length: profile.concurrency }, worker));
durations.sort((a, b) => a - b);
const failures = Object.entries(statuses).filter(([status]) => status === 'network' || Number(status) >= 400).reduce((sum, [, count]) => sum + count, 0);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)];
const result = {
  profile: profileName,
  tenantWorkspaces: profile.tenantWorkspaces,
  requests: durations.length,
  concurrency: profile.concurrency,
  elapsedMs: Date.now() - started,
  p50Ms: Math.round(percentile(0.5)),
  p95Ms: Math.round(percentile(0.95)),
  p99Ms: Math.round(percentile(0.99)),
  errorRate: failures / durations.length,
  statuses,
  thresholds: { p95Ms: profile.p95Ms, maxErrorRate: profile.maxErrorRate }
};
result.passed = result.p95Ms <= profile.p95Ms && result.errorRate <= profile.maxErrorRate;
const output = `${JSON.stringify(result, null, 2)}\n`;
console.log(output);
if (args.output) await writeFile(args.output, output);
if (!result.passed) process.exitCode = 1;
