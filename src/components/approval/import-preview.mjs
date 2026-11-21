function reviewExclusion(row) {
  const verified = row.verification;
  if (!verified?.identity || !["current", "no_longer_current"].includes(verified.status) ||
      !["doctor", "pharmacist"].includes(verified.reviewer?.role)) return "Clinician verification is pending.";

  const resolutions = new Set(verified.resolved_discrepancies ?? []);
  const discrepancies = row.discrepancies ?? [];
  if (resolutions.size !== discrepancies.length || discrepancies.some(item => !resolutions.has(item.id))) {
    return "Review evidence discrepancies.";
  }
  if (verified.status === "no_longer_current") return null;
  const complete = verified.regimens?.length ? verified.regimens.every(component =>
    component.basis === "verified" && component.parse_status === "complete" &&
    [component.dose_amount, component.dose_unit, component.route, component.schedule_type].every(value => value != null)
  ) : verified.dose && verified.route && verified.frequency;
  return complete ? null : "Verify dose, route and frequency.";
}

function previewOf({ reviewer, rows, evidence, selectedRowIds }) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const ready = [];
  const excluded = [];
  for (const id of new Set(selectedRowIds)) {
    const row = byId.get(id);
    if (!row) {
      excluded.push({ label: id, reason: "This row is no longer in the draft." });
      continue;
    }
    const reason = reviewExclusion(row);
    if (reason) {
      excluded.push({ label: row.unknown_label ?? row.observed_names?.[0]?.value ?? id, reason });
      continue;
    }
    const { approval: _approval, ...reviewed } = row;
    ready.push(reviewed);
  }
  ready.sort((left, right) => left.id.localeCompare(right.id));
  const importKey = JSON.stringify([reviewer?.id, reviewer?.role, evidence, ready]);
  const key = JSON.stringify([importKey, excluded]);
  return { reviewer, ready, excluded, key, importKey, evidence };
}

function element(document, tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function sourceNames(row, evidence) {
  const verification = row.verification;
  const regimenEvidence = (verification.regimens ?? []).flatMap(component => Object.values(component.evidence));
  const citations = [...row.sources, ...verification.evidence, verification.identity.evidence, ...regimenEvidence];
  for (const field of [verification.dose, verification.route, verification.frequency]) {
    if (field) citations.push(field.evidence);
  }
  const names = new Map(evidence.sources.map(source => [source.id, source.organization ?? source.id]));
  return [...new Set(citations.map(ref => ref.source_id))].map(id => names.get(id) ?? id).join(", ");
}

/** Use the workspace's authenticated API adapter. Server errors may reject with a ServiceError or { detail }. */
export function mountImportPreview(container, { getDraft, api, onImported = () => {},
  newRetryToken = () => globalThis.crypto.randomUUID() }) {
  const document = container.ownerDocument;
  const details = document.createElement("div");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const confirm = element(document, "button", "Approve and import selected rows");
  confirm.type = "button";
  const panel = document.createElement("section");
  panel.append(element(document, "h3", "Import preview"), details, confirm, status);
  container.replaceChildren(panel);

  let preview;
  let attempt;
  let busy = false;
  let disposed = false;

  function refresh(message = "") {
    const next = previewOf(getDraft());
    if (preview?.importKey !== next.importKey) attempt = undefined;
    preview = next;
    const ready = document.createElement("ul");
    for (const row of next.ready) {
      const verification = row.verification;
      const name = verification.identity.value;
      const use = verification.status === "current" ? "Current" : "No longer current";
      const entry = element(document, "li", name);
      entry.append(element(document, "p", `${use} · Verified by ${verification.reviewer.name}`));
      entry.append(element(document, "p", `Sources: ${sourceNames(row, next.evidence)}`));
      ready.append(entry);
    }
    details.replaceChildren(element(document, "h4", "Selected rows ready for validation"), ready);
    if (next.excluded.length) {
      const excluded = document.createElement("ul");
      for (const row of next.excluded) excluded.append(element(document, "li", `${row.label} · ${row.reason}`));
      details.append(element(document, "h4", "Excluded"), excluded);
    }
    const pharmacist = next.reviewer?.role === "pharmacist";
    confirm.disabled = disposed || busy || !pharmacist || !next.ready.length || Boolean(attempt?.receipt || attempt?.conflict);
    status.textContent = message || (attempt?.receipt ? `Imported at ${attempt.receipt.imported_at}.` : "") ||
      attempt?.conflict ||
      (!pharmacist ? "A pharmacist can approve the import." : "");
  }

  confirm.addEventListener("click", async () => {
    if (confirm.disabled) return;
    const approvedPreview = preview;
    const matchesPreview = () => !disposed && previewOf(getDraft()).key === approvedPreview.key;
    const changedMessage = "The draft changed. Review the selection and confirm again.";
    if (!matchesPreview()) {
      refresh(changedMessage);
      return;
    }

    // Keep the approval payload and retry token together; the server replays only an identical import.
    const submission = attempt ??= { token: newRetryToken(), approvals: new Map() };
    const isCurrent = () => attempt === submission && matchesPreview();
    const { evidence, ready } = structuredClone({ evidence: approvedPreview.evidence, ready: approvedPreview.ready });
    busy = true;
    refresh("Validating the selected rows…");
    let receipt;
    let message;
    try {
      for (const row of ready) {
        if (!isCurrent()) break;
        if (!submission.approvals.has(row.id)) {
          const approval = await api("/imports/approvals", { evidence, row });
          submission.approvals.set(row.id, approval);
        }
      }
      if (isCurrent()) {
        receipt = await api("/imports", {
          evidence, retry_token: submission.token, selected_row_ids: ready.map(row => row.id),
          rows: ready.map(row => ({ ...row, approval: submission.approvals.get(row.id) })),
        });
        submission.receipt = receipt;
        message = isCurrent() ? `Imported at ${receipt.imported_at}.` : "";
      } else {
        message = changedMessage;
      }
    } catch (failure) {
      const detail = failure?.detail ?? failure;
      if (!isCurrent()) {
        message = changedMessage;
      } else if (detail?.code === "approval_required") {
        // Recover with fresh approval and the same retry identity, even after an uncertain earlier write.
        submission.approvals.clear();
        message = "The server requires fresh approval. Confirm the current selection again.";
      } else if (detail?.code === "retry_conflict") {
        submission.conflict = "The receiving system already recorded this retry. Verify that record before importing again.";
      } else {
        message = detail?.recoverable === true && typeof detail.message === "string" ?
          `${detail.message} The draft is still available.` : "Import could not be confirmed. The draft is available to retry.";
      }
    } finally {
      busy = false;
      if (!disposed) refresh(message);
    }
    if (receipt) onImported(receipt);
  });

  refresh();
  return { refresh, dispose() { disposed = true; panel.remove(); } };
}
