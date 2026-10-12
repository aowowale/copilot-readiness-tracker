// Notification delivery for owner reviews. Recipients come only from the tenant's own directory
// data (workspace owners, their managers, the mover's manager) and one configured operator
// address, never from free text. Messages are plain text from fixed templates and carry no
// content from the workspace beyond its name. Each notification is sent once: a record with a
// dedupe key is written for every attempt, so reruns never repeat a message.
//
// Modes: off (nothing), dry-run (the default: records what would be sent), live (sends with the
// executor identity from one configured mailbox, so it needs the executor to be enabled).

export const MAX_ATTEMPTS = 3;
const MAX_PER_RUN = 200;
const ASSIGNED_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const EMAIL = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,255}\.[^\s@,;<>]{2,}$/;

const clean = (value, max = 200) => String(value ?? "").replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim().slice(0, max);
const dueText = (task) => new Date(task.dueAt).toISOString().slice(0, 10);

function templates(task, appUrl) {
  const link = appUrl ? `${appUrl.replace(/\/$/, "")}/#owner` : "the governance dashboard";
  const name = clean(task.workspaceName, 120);
  const mover = task.taskType === "mover-review";
  const footer = "No workspace is archived or deleted because of this message, and nothing changes unless you decide it.";
  return {
    assigned: {
      subject: mover ? `Access review needed: ${name}` : `Review needed: ${name}`,
      body: mover
        ? `A role change needs your decision. Please review which Teams ${clean(task.subject?.displayName || "this person")} should keep in the new role.\n\nDue: ${dueText(task)}\nOpen: ${link}\n\n${footer}`
        : `A governance review is waiting for you: ${name}.\n\nPlease confirm the contacts, members, permissions, sharing and purpose, then choose keep, archive or delete.\nDue: ${dueText(task)}\nOpen: ${link}\n\n${footer}`
    },
    1: { subject: `Reminder, review overdue: ${name}`, body: `The review "${name}" was due on ${dueText(task)}.\nOpen: ${link}\n\n${footer}` },
    2: { subject: `Escalation, review overdue: ${name}`, body: `The review "${name}" was due on ${dueText(task)} and has not been answered by its owners.\nOpen: ${link}\n\n${footer}` },
    3: { subject: `Governance queue: ${name}`, body: `The review "${name}" is more than two weeks overdue and is now with the governance team.\nOpen: ${link}\n\n${footer}` }
  };
}

function ownersOf(task, workspace) {
  const ids = new Set(task.assigneeIds);
  return (workspace?.ownerDetails || []).filter((owner) => ids.has(owner.id)).map((owner) => ({ id: owner.id, name: owner.displayName || null, mail: owner.mail || owner.userPrincipalName || null }));
}

function managersOf(workspace) {
  const seen = new Map();
  for (const owner of workspace?.ownerDetails || []) {
    if (owner.managerId && !seen.has(owner.managerId)) seen.set(owner.managerId, { id: owner.managerId, name: owner.managerName || null, mail: owner.managerMail || null });
  }
  return [...seen.values()];
}

export function planNotifications({ tasks, workspaces, driftAlerts = [], appUrl = "", operatorEmail = "", now = new Date() }) {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const operator = operatorEmail ? [{ id: "governance-queue", name: "Governance queue", mail: operatorEmail }] : [];
  const planned = [];

  for (const task of tasks) {
    if (["decided", "pending-approval"].includes(task.status)) continue;
    const workspace = workspaceById.get(task.workspaceId);
    const text = templates(task, appUrl);
    const add = (event, recipients, message) => {
      for (const recipient of recipients) {
        planned.push({
          dedupeKey: `${task.taskId}|${event}|${recipient.id}`,
          event,
          taskId: task.taskId,
          workspaceName: task.workspaceName,
          recipientId: recipient.id,
          recipientName: recipient.name || null,
          mail: recipient.mail || null,
          subject: clean(message.subject, 200),
          body: message.body
        });
      }
    };

    const direct = task.taskType === "mover-review"
      ? (task.managerContact ? [task.managerContact] : [])
      : task.assigneeKind === "governance-queue" ? operator : ownersOf(task, workspace);

    // Only tasks created recently announce themselves, so switching notifications on does not
    // send a backlog of old assignments.
    if (now - new Date(task.createdAt) <= ASSIGNED_WINDOW_DAYS * DAY_MS) add("assigned", direct, text.assigned);

    const level = Number(task.escalationLevel) || 0;
    if (level === 1) add("escalation-1", direct, text[1]);
    if (level === 2) add("escalation-2", task.taskType === "mover-review" ? direct : managersOf(workspace), text[2]);
    if (level >= 3) add("escalation-3", operator, text[3]);
  }
  for (const alert of driftAlerts) {
    if (alert.status !== "open") continue;
    planned.push({
      dedupeKey: `drift|${alert.alertId}|${alert.cycle}|governance-queue`,
      event: "drift-alert",
      taskId: alert.alertId,
      workspaceName: alert.workspaceName,
      recipientId: "governance-queue",
      recipientName: "Governance queue",
      mail: operatorEmail || null,
      subject: clean(`Workspace change needs review: ${alert.workspaceName}`, 200),
      body: `An approved workspace baseline changed.\n\nWorkspace: ${clean(alert.workspaceName, 120)}\nWhat changed: ${clean(alert.label, 120)}\nBaseline: ${clean(alert.from, 120)}\nCurrent: ${clean(alert.to, 120)}\nSeverity: ${clean(alert.severity, 20)}\n\nOpen the dashboard to review the drift alert. No tenant change was made.`
    });
  }
  return planned;
}

export async function deliverNotifications({ planned, repository, mailer, mode, now = new Date(), max = MAX_PER_RUN }) {
  const result = { planned: planned.length, sent: 0, simulated: 0, skipped: 0, failed: 0, alreadyDone: 0, capped: 0 };
  if (mode === "off") return { ...result, off: true };

  let handled = 0;
  for (const item of planned) {
    const previous = await repository.readNotification(item.dedupeKey);
    if (previous && ["sent", "simulated", "skipped"].includes(previous.status)) { result.alreadyDone += 1; continue; }
    if (previous?.status === "failed" && previous.attempts >= MAX_ATTEMPTS) { result.alreadyDone += 1; continue; }
    if (handled >= max) { result.capped += 1; continue; }
    handled += 1;

    const record = {
      dedupeKey: item.dedupeKey, event: item.event, taskId: item.taskId, workspaceName: item.workspaceName,
      recipientId: item.recipientId, recipientName: item.recipientName, subject: item.subject,
      attempts: (previous?.attempts || 0) + 1, mode, updatedAt: new Date(now).toISOString()
    };
    if (!item.mail || !EMAIL.test(item.mail)) {
      await repository.writeNotification({ ...record, status: "skipped", detail: "No usable email address for this person." });
      result.skipped += 1;
    } else if (mode !== "live") {
      await repository.writeNotification({ ...record, status: "simulated", detail: "Dry run: nothing was sent." });
      result.simulated += 1;
    } else {
      try {
        await mailer.send({ to: item.mail, subject: item.subject, body: item.body });
        await repository.writeNotification({ ...record, status: "sent", detail: null });
        result.sent += 1;
      } catch (error) {
        await repository.writeNotification({ ...record, status: "failed", detail: `Send failed (${error?.status || "error"}).` });
        result.failed += 1;
      }
    }
  }
  return result;
}

export function createMailer(writeGraph, sender) {
  if (!writeGraph || typeof writeGraph.post !== "function") throw new Error("Live notifications need the executor identity.");
  if (!EMAIL.test(sender || "")) throw new Error("NOTIFY_SENDER must be a mailbox address.");
  return {
    send: ({ to, subject, body }) => writeGraph.post(`/users/${encodeURIComponent(sender)}/sendMail`, {
      message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: false
    })
  };
}
