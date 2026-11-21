const names = { DDI: "Drug interaction check", DRP: "Drug-related problem check" };
const statusLabels = {
  not_run: "Not run",
  unavailable: "Unavailable",
  partial: "Partial coverage",
  complete: "Completed",
};

/** Capture at request time, before awaiting the check. Keep the snapshot in memory. */
export function captureCheckSnapshot(request, referenceVersion = null) {
  const { kind, enabled, rows, evidence, context = {} } = request;
  const checkedRows = rows.map(({ approval: _approval, ...row }) => row)
    .sort((left, right) => left.id.localeCompare(right.id));
  const facts = Object.entries(context).sort(([left], [right]) => left.localeCompare(right));
  return { kind, enabled, key: JSON.stringify([kind, enabled, evidence, checkedRows, facts, referenceVersion]) };
}

function textElement(document, tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function scopeName(scope, rowNames) {
  const rows = scope.row_ids.map(id => rowNames.get(id) ?? id).join(" + ");
  return scope.rule_id ? `${scope.rule_id} (${rows})` : rows;
}

function appendList(document, panel, heading, lines) {
  if (!lines.length) return;
  const list = document.createElement("ul");
  for (const line of lines) list.append(textElement(document, "li", line));
  panel.append(textElement(document, "h4", heading), list);
}

function coverageCount(kind, evaluated, excluded) {
  if (kind === "DRP") return `Evaluated ${evaluated.length} of ${evaluated.length + excluded.length} rule scopes.`;
  const evaluatedPairs = evaluated.filter(scope => scope.row_ids.length === 2).length;
  const excludedPairs = excluded.filter(item => item.scope.row_ids.length === 2).length;
  const pairs = evaluatedPairs + excludedPairs;
  return pairs > 0 ? `Evaluated ${evaluatedPairs} of ${pairs} medication pairs.` : "No pair to assess.";
}

/** Draw one optional check. A snapshot mismatch keeps earlier findings out of the current review. */
export function renderCheckCoverage(container, { current, report, rowNames = new Map() }) {
  const document = container.ownerDocument;
  const panel = document.createElement("section");
  panel.append(textElement(document, "h3", names[current.kind]));
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  panel.append(status);
  container.replaceChildren(panel);

  const summary = report?.summary;
  if (!current.enabled || !summary || summary.status === "not_run") {
    status.textContent = statusLabels.not_run;
    return;
  }
  if (report.snapshot?.key !== current.key || summary.kind !== current.kind) {
    status.textContent = "Stale. Rerun this check for the current review.";
    return;
  }
  if (summary.simulated !== true || !Object.hasOwn(statusLabels, summary.status)) {
    status.textContent = statusLabels.unavailable;
    return;
  }

  status.textContent = statusLabels[summary.status];
  panel.append(textElement(document, "p", "Simulated review"));
  if (summary.source) {
    panel.append(textElement(document, "p", `${summary.source.name} · Version ${summary.source.version}`));
  }
  if (summary.ran_at) {
    const time = textElement(document, "time", summary.ran_at);
    time.dateTime = summary.ran_at;
    const run = textElement(document, "p", "Run time ");
    run.append(time);
    panel.append(run);
  }

  const { evaluated = [], excluded = [], findings = [] } = summary;
  panel.append(textElement(document, "p", coverageCount(current.kind, evaluated, excluded)));
  appendList(document, panel, "Evaluated", evaluated.map(scope => scopeName(scope, rowNames)));
  appendList(document, panel, "Excluded", excluded.map(item => `${scopeName(item.scope, rowNames)} · ${item.reason}`));
  appendList(document, panel, "Findings", findings.map(item =>
    `${scopeName(item.scope, rowNames)} · ${item.description} (${item.source.name}, ${item.source.version})`));
  if (evaluated.length > 0 && findings.length === 0) {
    panel.append(textElement(document, "p", "No findings within checked scope."));
  }
}
