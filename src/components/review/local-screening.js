import { markup } from "./local-screening-template.js";

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const { detail } = await response.json();
      message = detail?.message || (typeof detail === "string" ? detail : message);
    } catch { /* Non-JSON errors retain their HTTP status. */ }
    throw new Error(message);
  }
  return response.json();
}

function evidenceFor(rowId, suffix, kind) {
  const id = `${rowId}-${suffix}`;
  const ref = { source_id: id, item_id: `${id}-excerpt` };
  return {
    source: { id, kind },
    item: { id: ref.item_id, source_id: id, row_id: rowId, kind: "record_excerpt" },
    ref,
  };
}

export function pendingRecord(id, product, revision) {
  // This record documents intake of a candidate. It makes no identity or current-use claim.
  const intake = { id: `${id}-intake`, kind: "reviewer_record" };
  return {
    row: {
      id, revision, identity_status: "unlabeled",
      unknown_label: product ? "Catalogue selection awaiting verification" : "Unidentified medicine",
      sources: [{ source_id: intake.id }],
    },
    sources: [intake],
    items: [],
  };
}

export function verifiedRecord(id, product, revision, fields, reviewerId) {
  const identity = evidenceFor(id, "identity", fields.identity_source);
  const use = evidenceFor(id, "use", fields.use_source);
  const refs = [identity.ref, use.ref];
  return {
    sources: [identity.source, use.source], items: [identity.item, use.item],
    row: {
      id, revision, identity_status: "named", sources: refs,
      observed_names: [{ value: fields.identity_text.trim(), evidence: identity.ref }],
      reported_use: [{ value: fields.use_text.trim(), evidence: use.ref }],
      verification: {
        verified_at: new Date().toISOString(),
        reviewer: { id: reviewerId, name: `Self-declared ${fields.reviewer_role}`, role: fields.reviewer_role },
        status: fields.use_status,
        identity: { value: product.label, evidence: identity.ref },
        normalized_medication_id: product.tpu, tmt_release: product.tmt_release,
        evidence: refs,
      },
    },
  };
}

const outcomes = {
  potential: "Potential finding",
  lookup_complete: "Lookup complete within supported scope",
  partial: "Partially assessed",
  unassessed: "Unassessed",
};

function showReasons(section, reasons) {
  for (const reason of reasons) section.append(element("p", reason));
}

function appendInteraction(section, hit) {
  const detail = element("details", "");
  const summary = element("summary", `${hit.relevance} · FEST ${hit.rule_id}`);
  detail.append(summary);
  const fields = element("dl", "");
  for (const [label, value] of [
    ["Relevance", hit.relevance], ["Clinical consequence", hit.consequence],
    ["Condition", hit.condition], ["Mechanism", hit.mechanism], ["Evidence basis", hit.source_basis],
    ["Source updated", hit.updated], ["Matched ATC codes", hit.matched_atcs.map(side => side.join(", ")).join(" + ")],
  ]) {
    if (value) fields.append(element("dt", label), element("dd", value));
  }
  detail.append(fields);
  for (const ref of hit.references) {
    const item = element("p", "");
    if (typeof ref.url === "string" && /^https?:\/\//i.test(ref.url)) {
      const link = element("a", ref.title || ref.url);
      link.href = ref.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    } else {
      item.textContent = ref.title || "Reference without a public link";
    }
    detail.append(item);
  }
  section.append(detail);
}

function showReport(root, report, names, reviewedRows, caseEvidence) {
  const fragment = document.createDocumentFragment();
  fragment.append(element("h3", "Screening results"));
  fragment.append(element("p", `TMT ${report.tmt_release} · Mapping ${report.mapping_version} · FEST ${report.fest_release || "unavailable"} · Checked ${new Date(report.checked_at).toLocaleString()}`));
  const scope = element("p", report.ddi_scope);
  fragment.append(scope);
  if (report.ddi_unavailable_reason) fragment.append(element("p", report.ddi_unavailable_reason));
  const provenance = element("details", "");
  provenance.append(element("summary", "Screened medicines, mapping and case evidence"));
  provenance.open = report.rows.length === 1;
  for (const row of report.rows) {
    const reviewed = reviewedRows.find(item => item.id === row.row_id);
    const facts = [...(reviewed?.observed_names || []), ...(reviewed?.reported_use || [])];
    const desc = [row.reason, row.route_note, row.composition_status && `composition: ${row.composition_status}`,
      row.ddi_status && `DDI mapping: ${row.ddi_status}`].filter(Boolean).join(" · ");
    provenance.append(element("p", `${names.get(row.row_id) || row.label} · ${desc}`));
    const sources = element("ul", "");
    for (const ref of row.evidence) {
      const source = caseEvidence.sources.find(source => source.id === ref.source_id);
      const kind = source?.kind.replaceAll("_", " ") || ref.source_id;
      const fact = facts.find(fact => fact.evidence.source_id === ref.source_id && (fact.evidence.item_id || null) === ref.item_id);
      sources.append(element("li", [kind, fact?.value, ref.item_id].filter(Boolean).join(" · ")));
    }
    if (sources.children.length) provenance.append(sources);
  }
  fragment.append(provenance);
  if (!report.pairs.length) fragment.append(element("p", "No pair to assess. Add a second medicine to check interactions and shared ingredients."));
  const sections = [
    ["ddi", "Potential interactions"], ["duplicate", "Shared active ingredients"],
  ];
  for (const [key, heading] of sections) {
    const section = element("section", "");
    section.append(element("h3", heading));
    const totals = Object.fromEntries(Object.keys(outcomes).map(status => [status, 0]));
    for (const pair of report.pairs) totals[pair[key].status]++;
    const countLabel = report.pairs.length === 1 ? "pair" : "pairs";
    section.append(element("p", `${report.pairs.length} ${countLabel} · ${totals.potential} flagged · ${totals.lookup_complete} lookup complete · ${totals.partial} partial · ${totals.unassessed} unassessed`));
    for (const pair of report.pairs) {
      const part = pair[key];
      const card = element("article", "");
      card.append(element("h4", pair.row_ids.map(id => names.get(id) || id).join(" + ")));
      const outcome = element("strong", outcomes[part.status]);
      outcome.dataset.outcome = part.status;
      card.append(outcome);
      if (part.status === "partial" && part.interactions?.length) {
        card.append(element("p", `${part.interactions.length} matching FEST record(s) within the assessed scope.`));
      }
      showReasons(card, part.reasons);
      if (key === "ddi") {
        for (const hit of part.interactions) appendInteraction(card, hit);
      } else {
        for (const ingredient of part.ingredients) card.append(element("p", `${ingredient.name} · TMT substance ${ingredient.subs_id}`));
      }
      section.append(card);
    }
    fragment.append(section);
  }
  const attribution = element("p", "Contains information from the Norwegian Medical Products Agency (DMP) under ");
  const license = element("a", "NLOD 2.0");
  license.href = "https://data.norge.no/nlod/en/2.0";
  license.rel = "noopener noreferrer";
  license.target = "_blank";
  attribution.append(license, ".");
  fragment.append(attribution);
  root.replaceChildren(fragment);
}

// getBaseCase can supply existing scan/verification rows from the host workspace.
// Call baseChanged after any edit or verification to discard superseded reports.
export function mountLocalScreening(root, { getBaseCase, onListChange = () => {} } = {}) {
  root.innerHTML = markup;
  const find = selector => root.querySelector(selector);
  const list = find("#catalogue-rows");
  const query = find("#catalogue-query");
  const matches = find("#catalogue-results");
  const searchStatus = find("#catalogue-status");
  const status = find("#local-status");
  const reportPanel = find("#local-report");
  const run = find("#run-local");
  const section = find("#local-controls");
  const records = new Map();
  const emptyCase = { evidence: { case_id: crypto.randomUUID(), sources: [], items: [] }, rows: [] };
  const reviewerId = crypto.randomUUID();
  let nextRow = 0;
  let change = 0;
  let searchVersion = 0;
  let hasRun = false;
  let running = false;

  function base() {
    return getBaseCase?.() || emptyCase;
  }

  function refresh() {
    const baseRows = base().rows;
    const other = find("#other-case-row");
    other.hidden = !baseRows.length;
    other.textContent = baseRows.map(row => `${row.observed_names?.[0]?.value || row.unknown_label} · ${row.verification?.status || "pending"} (transfer case)`).join(" · ");
    const count = baseRows.length + records.size;
    run.disabled = running || count === 0;
    if (count === 0) status.textContent = "Add a medicine to review its coverage.";
  }

  function invalidate() {
    change++;
    running = false;
    reportPanel.replaceChildren();
    status.textContent = hasRun ? "The medicine list changed. Run the checks again." : "";
    refresh();
  }

  function add(product) {
    if (base().rows.length + records.size >= 100) {
      status.textContent = "This review already contains the maximum of 100 medicines.";
      return;
    }
    let id;
    do { id = `local-${++nextRow}`; } while (base().rows.some(row => row.id === id));
    let revision = 1;
    const row = find("#catalogue-row-template").content.firstElementChild.cloneNode(true);
    const title = product?.label || "Unidentified medicine";
    row.querySelector("h3").textContent = title;
    row.querySelector(".row-code").textContent = product
      ? `TMT TPU ${product.tpu} · ${product.tmt_release}${product.active_tmt === false ? " · Historical entry" : ""}` : "";
    const state = row.querySelector(".row-status");
    const details = row.querySelector(".row-details");
    state.textContent = product ? "Pending identity and use verification" : "Pending identification";
    row.querySelector(".remove-row").setAttribute("aria-label", `Remove ${title}`);
    records.set(id, { label: title, ...pendingRecord(id, product, revision) });
    if (!product) details.remove();
    else {
      const form = details.querySelector("form");
      function edit() {
        const record = records.get(id);
        if (record.row.verification) {
          records.set(id, { label: title, ...pendingRecord(id, product, ++revision) });
          state.textContent = "Edited · verify identity and use again";
        }
        invalidate();
      }
      form.addEventListener("input", edit);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const fields = Object.fromEntries(new FormData(form));
        for (const key of ["identity_text", "use_text"]) {
          if (!fields[key].trim()) {
            form.elements[key].focus();
            state.textContent = "Enter the source wording for identity and use.";
            return;
          }
        }
        const verified = verifiedRecord(id, product, ++revision, fields, reviewerId);
        records.set(id, { label: title, ...verified });
        state.textContent = `Reviewed by ${fields.reviewer_role} · ${form.elements.use_status.selectedOptions[0].textContent}`;
        details.open = false;
        invalidate();
      });
    }
    row.querySelector(".remove-row").addEventListener("click", () => {
      records.delete(id);
      row.remove();
      onListChange(records.size);
      invalidate();
      query.focus();
    });
    list.append(row);
    if (product) row.querySelector("select").focus();
    onListChange(records.size);
    invalidate();
  }

  query.addEventListener("input", () => {
    searchVersion++;
    matches.replaceChildren();
    searchStatus.textContent = "";
  });
  find("#catalogue-search").addEventListener("submit", async event => {
    event.preventDefault();
    const q = query.value.trim();
    const version = ++searchVersion;
    matches.replaceChildren();
    if (!q) {
      searchStatus.textContent = "Enter a medicine name or TPU code.";
      return;
    }
    searchStatus.textContent = "Searching…";
    try {
      const result = await request(`/checks/local/products?${new URLSearchParams({ q })}`);
      if (version !== searchVersion) return;
      searchStatus.textContent = result.products.length
        ? "Select the product matching the source." : "No matching product found.";
      for (const product of result.products) {
        const historical = product.active_tmt === false ? " · Historical entry" : "";
        const button = element("button", `${product.label} · TPU ${product.tpu}${historical}`);
        button.type = "button";
        button.addEventListener("click", () => {
          add({ ...product, tmt_release: result.tmt_release });
          query.value = "";
          matches.replaceChildren();
          searchStatus.textContent = "";
        });
        const item = element("li", "");
        item.append(button);
        matches.append(item);
      }
    } catch (error) {
      if (version === searchVersion) searchStatus.textContent = error.message;
    }
  });
  find("#add-unknown").addEventListener("click", () => add(null));

  run.addEventListener("click", async () => {
    const version = change;
    const original = base();
    const saved = [...records.values()];
    const rows = [...original.rows, ...saved.map(record => record.row)];
    const evidence = {
      ...original.evidence,
      sources: [...original.evidence.sources, ...saved.flatMap(record => record.sources)],
      items: [...original.evidence.items, ...saved.flatMap(record => record.items)],
    };
    const names = new Map(original.rows.map(row => [row.id, row.observed_names?.[0]?.value || row.unknown_label]));
    for (const record of saved) names.set(record.row.id, record.label);
    hasRun = true;
    running = true;
    refresh();
    status.textContent = "Checking the medication list…";
    reportPanel.replaceChildren();
    try {
      const report = await request("/checks/local", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, evidence }),
      });
      if (change !== version) return;
      showReport(reportPanel, report, names, rows, evidence);
      status.textContent = "Screening complete for this review.";
    } catch (error) {
      if (change === version) status.textContent = error.message;
    } finally {
      if (change === version) {
        running = false;
        refresh();
      }
    }
  });
  refresh();
  return {
    baseChanged: invalidate,
    setLocked(locked) { section.disabled = locked; },
    get rowCount() { return records.size; },
  };
}
