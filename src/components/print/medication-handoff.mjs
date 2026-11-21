import { captureCheckSnapshot, renderCheckCoverage } from "../checks/coverage-panel.mjs";

const sourceKinds = {
  label_photo: "Label photo", reverse_photo: "Reverse-side photo", additional_photo: "Additional photo",
  prescription: "Prescription", transfer_record: "Transfer record", patient_report: "Patient report",
  caregiver_report: "Caregiver report", reviewer_record: "Reviewer record", other_record: "Other record",
};
const photoKinds = new Set(["label_photo", "reverse_photo", "additional_photo"]);
const clinicianRoles = new Set(["nurse", "doctor", "pharmacist"]);
const identityRecords = new Set(["prescription", "transfer_record", "reviewer_record"]);
const useRecords = new Set(["patient_report", "caregiver_report", "transfer_record", "reviewer_record", "other_record"]);
const fieldNames = {
  identity: "Identity", directions: "Documented directions", reported_use: "Reported use",
  period_value: "Period length", time_of_day: "Time of day", as_needed: "As needed",
};

function fieldName(key) {
  return fieldNames[key] ?? key[0].toUpperCase() + key.slice(1).replaceAll("_", " ");
}

function node(document, tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(document, list, title, value, citation) {
  const answer = node(document, "dd", value);
  if (citation) {
    const detail = node(document, "span", citation);
    detail.className = "handoff-citation";
    answer.append(detail);
  }
  list.append(node(document, "dt", title), answer);
}

function group(document, parent, title) {
  const section = node(document, "section");
  section.append(node(document, "h4", title));
  parent.append(section);
  return section;
}

function dateNode(document, value) {
  const time = node(document, "time", value);
  time.dateTime = value;
  return time;
}

function sourceName(source) {
  const kind = sourceKinds[source.kind] ?? source.kind;
  const reporter = source.organization && source.reporter ? `Reported by ${source.reporter}` : source.reporter;
  return `${[kind, source.organization, reporter].filter(Boolean).join(" · ")} [${source.id}]`;
}

function citationsFor(row, evidence) {
  const used = new Map();
  const sources = new Map(evidence.sources.map(source => [source.id, source]));

  function locate(ref) {
    if (!ref?.item_id) return null;
    return (evidence.items ?? []).find(item => item.id === ref.item_id &&
      item.source_id === ref.source_id && item.row_id === row.id) ?? null;
  }

  function describe(ref, { claim = true, followUp = false } = {}) {
    const source = sources.get(ref?.source_id);
    if (!source || (source.availability === "unavailable" && !followUp)) return null;
    const item = locate(ref);
    if ((ref.item_id || (claim && photoKinds.has(source.kind))) && !item) return null;
    if (!used.has(source.id)) used.set(source.id, { source, items: new Set() });
    if (item) used.get(source.id).items.add(item.id);
    return [sourceName(source), item?.id].filter(Boolean).join(" · ");
  }

  function cropAvailable(ref) {
    return sources.get(ref?.source_id)?.kind === "reverse_photo" && locate(ref)?.kind === "pill_crop" &&
      Boolean(describe(ref));
  }

  function supportsIdentity(ref, independent = false) {
    const source = sources.get(ref?.source_id);
    if (!source) return false;
    const challenged = independent ? sources.get(row.reverse_crop?.source_id) : null;
    if (challenged && (source.id === challenged.id ||
        (source.attachment_id && source.attachment_id === challenged.attachment_id))) return false;
    if (photoKinds.has(source.kind)) {
      const expected = source.kind === "reverse_photo" ? "matched_reverse_label" : "label_region";
      if (locate(ref)?.kind !== expected) return false;
    } else if (independent && (!identityRecords.has(source.kind) || locate(ref)?.kind !== "record_excerpt")) {
      return false;
    }
    return Boolean(describe(ref));
  }

  function supportsUse(ref) {
    return useRecords.has(sources.get(ref?.source_id)?.kind) && Boolean(describe(ref));
  }

  return { describe, cropAvailable, supportsIdentity, supportsUse, used };
}

function sourceDetails(document, article, sources) {
  const section = group(document, article, "Sources and contacts");
  const list = node(document, "ul");
  for (const { source, items } of sources.values()) {
    const phone = source.organization_phone;
    const contact = [source.department_or_ward, source.organization_address,
      phone && `Phone ${phone}${source.organization_phone_extension ? ` ext. ${source.organization_phone_extension}` : ""}`,
      source.organization_email, source.contact && source.contact !== phone ? source.contact : null,
    ].filter(Boolean);
    const item = node(document, "li", sourceName(source));
    if (items.size) item.append(node(document, "br"), node(document, "span", `Evidence items: ${[...items].join(", ")}`));
    if (source.source_date) item.append(node(document, "br"), dateNode(document, source.source_date));
    if (source.collector) item.append(node(document, "br"), node(document, "span", `Collected by ${source.collector}`));
    if (contact.length) item.append(node(document, "br"), node(document, "span", contact.join(" · ")));
    if (source.availability === "unavailable") {
      item.append(node(document, "br"), node(document, "span", `Unavailable. ${source.unavailable_reason}`));
    }
    list.append(item);
  }
  section.append(sources.size ? list : node(document, "p", "Source information unavailable."));
}

function sourcedField(document, list, title, observation, cite) {
  const citation = observation?.evidence ? cite(observation.evidence) : null;
  const value = observation?.value;
  const missing = observation?.status === "unreadable" ? "Unreadable" : "Missing";
  field(document, list, title, value == null ? missing : citation ? value : "Evidence unavailable", citation);
}

function regimen(document, parent, components, cite) {
  for (const component of components) {
    const list = node(document, "dl");
    sourcedField(document, list, "Original wording", {
      value: component.directions_text, evidence: component.evidence.directions_text,
    }, cite);
    if (component.parse_status !== "complete") {
      field(document, list, "Parse status", component.parse_status === "partial" ? "Partial" : "Unparsed");
    }
    for (const [key, ref] of Object.entries(component.evidence)) {
      if (key === "directions_text") continue;
      const value = component[key];
      sourcedField(document, list, fieldName(key), {
        value: Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : value,
        evidence: ref,
      }, cite);
    }
    if (component.unparsed_text) sourcedField(document, list, "Wording to clarify", {
      value: component.unparsed_text, evidence: component.evidence.directions_text,
    }, cite);
    parent.append(list);
  }
}

function renderRow(document, row, options) {
  const { evidence, decisions, referrals, cropUrl, mode } = options;
  const { describe: cite, cropAvailable, supportsIdentity, supportsUse, used } = citationsFor(row, evidence);
  const article = node(document, "article");
  article.className = "handoff-row";
  for (const ref of row.sources) cite(ref, { claim: false });
  const unknown = row.identity_status !== "named";
  const verification = clinicianRoles.has(row.verification?.reviewer?.role) ? row.verification : null;
  const verifiedIdentity = verification?.identity && (!unknown || verification.reviewer.role === "pharmacist") &&
    supportsIdentity(verification.identity.evidence, unknown) ? verification.identity : null;
  const resolved = new Set(verification?.resolved_discrepancies ?? []);
  const discrepancies = row.discrepancies ?? [];
  const pendingIdentity = discrepancies.some(item => item.field === "identity" && !resolved.has(item.id)) ||
    (unknown && !verifiedIdentity);
  const confirmedName = pendingIdentity ? null : verifiedIdentity;
  const observedName = (row.observed_names ?? []).find(name => supportsIdentity(name.evidence));
  const identity = confirmedName?.value ?? row.unknown_label ?? observedName?.value ?? "Unknown medication";
  article.append(node(document, "h3", identity));
  if (unknown) article.append(node(document, "p", `Item ${row.id}`));
  if (pendingIdentity) article.append(node(document, "p", "Identity unresolved"));
  if (verification) {
    let status = "Current use uncertain";
    if (verification.status === "not_owned") {
      status = "Verified as belonging to someone else";
    } else if (verification.status === "no_longer_current") {
      status = "No longer current";
    } else if (verification.status === "current") {
      if (confirmedName) status = "Verified current";
      else if (verification.evidence.some(supportsUse)) status = "Current use verified for this unidentified item";
    }
    article.append(node(document, "p", status));
  } else if (!pendingIdentity) {
    article.append(node(document, "p", "Verification pending"));
  }

  const crop = cropAvailable(row.reverse_crop) ? cropUrl(row.reverse_crop) : null;
  if (crop) {
    const figure = node(document, "figure");
    const image = node(document, "img");
    const fallback = node(document, "p", "No usable reverse-side crop available.");
    fallback.hidden = true;
    image.alt = `Matched reverse-side crop for ${identity}`;
    image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; });
    figure.append(image, fallback, node(document, "figcaption", cite(row.reverse_crop)));
    image.src = crop;
    article.append(figure);
  } else if (row.identity_status !== "named" || row.reverse_crop) {
    article.append(node(document, "p", "No usable reverse-side crop available."));
  }

  const recorded = group(document, article, "Documented information");
  const label = node(document, "dl");
  for (const name of row.observed_names ?? []) sourcedField(document, label, "Observed name", name, cite);
  const dispensing = row.dispensing_source_id ? cite({ source_id: row.dispensing_source_id }, { claim: false }) : null;
  field(document, label, "Dispensing source", dispensing ?? "Unknown");
  const labelFields = row.label_fields ?? {};
  const components = row.regimens ?? [];
  const documented = components.filter(component => component.basis === "documented");
  for (const [key, observation] of Object.entries(labelFields)) {
    sourcedField(document, label, fieldName(key), observation, cite);
  }
  const missingDirections = !(labelFields.directions?.value && cite(labelFields.directions.evidence)) &&
    !documented.some(component => cite(component.evidence.directions_text));
  if (missingDirections && !labelFields.directions) field(document, label, "Documented directions", "Missing");
  recorded.append(label);
  regimen(document, recorded, documented, cite);

  const reports = group(document, article, "Reported use");
  const answers = node(document, "dl");
  for (const report of row.reported_use ?? []) sourcedField(document, answers, "Account", report, cite);
  if (answers.childNodes.length) reports.append(answers);
  const reported = components.filter(component => component.basis === "reported");
  if (!reported.length && !row.reported_use?.length) reports.append(node(document, "p", "No account recorded."));
  regimen(document, reports, reported, cite);

  const reviewed = group(document, article, "Clinician verification");
  if (verification) {
    const info = node(document, "p", `${verification.reviewer.name} · ${verification.reviewer.role} · `);
    info.append(dateNode(document, verification.verified_at));
    reviewed.append(info);
    const verified = node(document, "dl");
    if (confirmedName) sourcedField(document, verified, "Verified identity", confirmedName, cite);
    for (const key of ["dose", "route", "frequency"]) {
      if (verification[key]) sourcedField(document, verified, fieldName(key), verification[key], cite);
    }
    for (const ref of verification.evidence) {
      const citation = cite(ref);
      if (citation) field(document, verified, "Verification evidence", citation);
    }
    if (verified.childNodes.length) reviewed.append(verified);
    regimen(document, reviewed, verification.regimens ?? [], cite);
  } else {
    reviewed.append(node(document, "p", "No verified use recorded."));
  }

  for (const decision of decisions.filter(decision => decision.row_id === row.id)) {
    const source = cite({ source_id: decision.source_id, item_id: decision.item_id }, { claim: false });
    const detail = node(document, "p", `Decision: ${decision.outcome}${source ? ` · ${decision.finding} · ${source}` : " · Evidence unavailable"}`);
    reviewed.append(detail);
  }

  const followUps = row.follow_ups ?? [];
  const rowReferrals = referrals.filter(referral => referral.row_ids.includes(row.id));
  if (discrepancies.length || followUps.length || rowReferrals.length || missingDirections) {
    const questions = group(document, article, "Discrepancies and follow-up");
    const list = node(document, "ul");
    for (const discrepancy of discrepancies) {
      const open = !resolved.has(discrepancy.id);
      const item = node(document, "li", `${fieldName(discrepancy.field)} · ${open ? "Unresolved" : "Resolved"}`);
      const values = node(document, "dl");
      for (const observed of discrepancy.observed_values) sourcedField(document, values, "Observed", observed, cite);
      item.append(values);
      if (open) item.append(node(document, "p", discrepancy.question));
      list.append(item);
    }
    for (const item of followUps) {
      const source = cite({ source_id: item.potential_source_id }, { claim: false, followUp: true });
      list.append(node(document, "li", source ? `${item.question} · ${source}` : item.question));
    }
    if (missingDirections) list.append(node(document, "li", "Check the documented directions with the source."));
    for (const referral of rowReferrals) {
      const details = [referral.reason, referral.checked && `Checked: ${referral.checked}`].filter(Boolean);
      list.append(node(document, "li", `Pending pharmacist referral · ${details.join(" · ")}`));
    }
    questions.append(list);
  }

  sourceDetails(document, article, used);
  const notes = group(document, article, mode === "worksheet" ? "Interview notes" : "Handoff notes");
  const lines = node(document, "div");
  lines.className = "handoff-notes";
  lines.setAttribute("aria-hidden", "true");
  notes.append(lines);
  return { article, identity, status: verification?.status };
}

/** Render a #2 review snapshot. Include medication-handoff.css in the host page. */
export function renderMedicationHandoff(container, {
  evidence, rows, datedAt, mode = "reviewed", cropUrl = () => null,
  checks = [], referrals = [], decisions = [],
}) {
  const document = container.ownerDocument;
  const handoff = node(document, "section");
  handoff.className = "medication-handoff";
  const heading = mode === "worksheet" ? "Medication interview worksheet" : "Reviewed medication handoff";
  handoff.append(node(document, "h1", heading), dateNode(document, datedAt));
  const active = node(document, "section");
  const history = node(document, "section");
  const otherOwner = node(document, "section");
  active.append(node(document, "h2", "Active review list"));
  history.append(node(document, "h2", "Medication history"));
  otherOwner.append(node(document, "h2", "Medicines belonging to someone else"));
  const rowNames = new Map();
  for (const row of rows) {
    const { article, identity, status } = renderRow(document, row, { evidence, decisions, referrals, cropUrl, mode });
    rowNames.set(row.id, identity);
    const section = status === "not_owned" ? otherOwner : status === "no_longer_current" ? history : active;
    section.append(article);
  }
  if (active.childNodes.length === 1) active.append(node(document, "p", "No active or pending rows."));
  handoff.append(active);
  if (history.childNodes.length > 1) handoff.append(history);
  if (otherOwner.childNodes.length > 1) handoff.append(otherOwner);

  if (checks.length) {
    const optional = node(document, "section");
    optional.append(node(document, "h2", "Optional screening summaries"));
    for (const check of checks) {
      const target = node(document, "div");
      const current = captureCheckSnapshot({ ...check, evidence, rows }, check.referenceVersion);
      renderCheckCoverage(target, { current, report: check.report, rowNames });
      optional.append(target);
    }
    handoff.append(optional);
  }
  container.replaceChildren(handoff);
}
