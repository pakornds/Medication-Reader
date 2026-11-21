const dispositionLabels = {
  reviewed: "Reviewed",
  additional_evidence: "Additional evidence needed",
  documented: "Documented disposition",
};

const reasonLabels = {
  discontinued_medication: "Discontinued medicine",
  doctor_or_pharmacist_verification_required: "Doctor or pharmacist verification required",
  expired_reference: "Reference expired",
  incomplete_mapping: "Incomplete ingredient mapping",
  missing_route: "Route is missing",
  reference_not_current: "Reference is not current",
  unconfirmed_overlap: "Overlapping use is unconfirmed",
  unresolved_identity: "Unresolved medication identity",
  unsupported_route: "Route is outside the reference scope",
  unsupported_rule: "Rule is outside the reference scope",
  use_not_current: "Current use is unverified",
};

function element(document, tag, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function appendList(document, container, heading, lines) {
  if (!lines.length) return;
  const list = document.createElement("ul");
  for (const line of lines) list.append(element(document, "li", line));
  container.append(element(document, "h5", heading), list);
}

function renderDisposition(document, card, saved, save, allowed) {
  const status = element(document, "p");
  status.setAttribute("role", "status");
  const show = value => {
    const label = dispositionLabels[value?.status];
    status.textContent = value?.note ? label + " · " + value.note : label ?? "";
  };
  show(saved);
  card.append(status);
  if (!allowed) return;

  const form = document.createElement("form");
  const label = element(document, "label", "Disposition ");
  const select = document.createElement("select");
  select.required = true;
  for (const [value, text] of [["", "Select a disposition"], ...Object.entries(dispositionLabels)]) {
    const option = element(document, "option", text);
    option.value = value;
    select.append(option);
  }
  select.value = saved?.status ?? "";
  label.append(select);

  const noteLabel = element(document, "label", "Assessment ");
  const note = document.createElement("input");
  note.maxLength = 1000;
  note.value = saved?.note ?? "";
  noteLabel.append(note);
  const updateNote = () => {
    noteLabel.hidden = select.value !== "documented";
    note.disabled = noteLabel.hidden;
    note.required = !noteLabel.hidden;
  };
  select.addEventListener("change", updateNote);
  updateNote();

  const button = element(document, "button", "Save disposition");
  button.type = "submit";
  form.append(label, noteLabel, button);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = { status: select.value, note: note.disabled ? "" : note.value.trim() };
    if (!Object.hasOwn(dispositionLabels, value.status) || (note.required && !value.note)) return;
    if (save(value)) show(value);
  });
  card.append(form);
}

function renderScope(document, scope, context) {
  const { rows, evidence, release, snapshot, report } = context;
  const products = scope.row_ids.map(id => rows.get(id));
  const rule = release.rules.find(item =>
    item.id === scope.rule_id && item.version === scope.rule_version && item.kind === report.kind);
  const names = products.map((row, index) => row?.product_name ?? scope.row_ids[index]).join(" + ");
  const label = {
    finding: rule?.description ?? "Potential finding",
    no_finding: "No finding in this comparison",
    unevaluated: "Not evaluated",
  }[scope.outcome];
  const card = document.createElement("details");
  card.append(element(document, "summary", label + " · " + names));

  if (rule) {
    const reference = element(document, "p", rule.id + " · Version " + rule.version + " · ");
    const link = element(document, "a", scope.reference_section);
    link.href = rule.reference.source_url;
    reference.append(link);
    card.append(reference);
  }
  if (scope.ingredient_ids?.length) {
    card.append(element(document, "p", "Ingredients assessed · " + scope.ingredient_ids.join(", ")));
  }

  const rowEvidence = new Set();
  for (const [index, row] of products.entries()) {
    if (!row) continue;
    const schedule = { scheduled: "Scheduled", prn: "As needed (PRN)" }[row.schedule] ?? "Schedule unknown";
    card.append(element(document, "h4", (row.product_name ?? scope.row_ids[index]) + " · " + schedule));
    for (const id of row.evidence_ids) rowEvidence.add(id);
    appendList(document, card, "Sources", row.evidence_ids.map(id => evidence.get(id)).filter(Boolean));
  }
  appendList(document, card, "Additional sources", (scope.evidence_ids ?? [])
    .filter(id => !rowEvidence.has(id)).map(id => evidence.get(id)).filter(Boolean));

  const gaps = scope.reason_code ? [reasonLabels[scope.reason_code] ?? scope.reason_code.replaceAll("_", " ")] : [];
  const exposure = snapshot.exposures?.find(item =>
    scope.row_ids.length === 2 && scope.row_ids.every(id => item.row_ids.includes(id)));
  if (report.kind === "DRP" && products.some(row => row?.schedule === "prn")
      && (!exposure || exposure.status === "unknown")) {
    gaps.push("Overlapping use is unconfirmed for the as-needed medicine.");
  }
  appendList(document, card, "Known gaps", gaps);
  appendList(document, card, "Follow-up", release.follow_ups
    .filter(item => scope.follow_up_ids?.includes(item.id)).map(item => item.question));
  return card;
}

function snapshotKey(snapshot) {
  return snapshot && JSON.stringify([snapshot.case_id, snapshot.snapshot_id, snapshot.release_id]);
}

/** Render a validated screening report. Keep dispositions in this mounted view for the active snapshot only. */
export function mountReviewItems(container) {
  const document = container.ownerDocument;
  const dispositions = new Map();
  let currentKey;
  let renderCount = 0;

  return function render({ snapshot, report, release, canRecordDisposition = false }) {
    const key = snapshot?.current === false ? null : snapshotKey(snapshot);
    if (key !== currentKey) dispositions.clear();
    currentKey = key;
    const count = ++renderCount;
    const panel = document.createElement("section");
    panel.append(element(document, "h3", "Screening details"));
    container.replaceChildren(panel);
    const status = element(document, "p");
    status.setAttribute("role", "status");
    panel.append(status);
    if (!report) {
      status.textContent = "Screening has not run.";
      return;
    }
    if (!key || key !== snapshotKey(report) || release?.id !== snapshot.release_id) {
      status.textContent = "Screening is stale. Rerun it for the current review.";
      return;
    }
    if (report.status === "not_run") {
      status.textContent = "Screening has not run.";
      return;
    }
    status.textContent = "Simulated review · " + report.release_id;
    const supportedRoutes = new Set(release.rules
      .filter(rule => rule.kind === report.kind).flatMap(rule => rule.routes));
    const eligibleProducts = new Set(snapshot.rows
      .filter(row => row.use_status === "current" && row.mapping_status === "complete"
        && supportedRoutes.has(row.route))
      .map(row => row.product_id));
    const { evaluated_scopes: evaluated, total_scopes: total, findings } = report.coverage;
    const scopes = report.kind === "DDI" ? "medication pairs" : "rule scopes";
    if (eligibleProducts.size < 2 && evaluated === 0) {
      panel.append(element(document, "p", "No pair to assess."));
    } else {
      const percent = total ? " (" + Math.round(evaluated / total * 100) + "%)" : "";
      panel.append(element(document, "p", "Evaluated " + evaluated + " of " + total + " " + scopes + percent + "."));
    }
    if (evaluated && !findings) {
      panel.append(element(document, "p", "No findings within checked scope."));
    }
    for (const warning of report.warnings ?? []) panel.append(element(document, "p", warning));

    const rows = new Map(snapshot.rows.map(row => [row.id, row]));
    const evidence = new Map(snapshot.evidence.map(item => [item.id, item.id + " · " + item.description]));
    const context = { rows, evidence, release, snapshot, report };
    const children = new Map();
    for (const scope of report.scopes) {
      if (!scope.parent_scope_id) continue;
      const siblings = children.get(scope.parent_scope_id) ?? [];
      siblings.push(scope);
      children.set(scope.parent_scope_id, siblings);
    }
    for (const scope of report.scopes) {
      if (scope.parent_scope_id || scope.outcome === "no_finding") continue;
      const card = renderScope(document, scope, context);
      for (const child of children.get(scope.scope_id) ?? []) {
        card.append(renderScope(document, child, context));
      }
      if (scope.outcome === "finding") {
        const scopeKey = JSON.stringify([report.kind, scope.scope_id]);
        renderDisposition(document, card, dispositions.get(scopeKey), value => {
          if (count !== renderCount) return false;
          dispositions.set(scopeKey, value);
          return true;
        }, canRecordDisposition);
      }
      panel.append(card);
    }
  };
}
