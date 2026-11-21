import { renderRegimenEvidence } from "./regimen-editor.js";

const reportKinds = new Set(["patient_report", "caregiver_report"]);
const regimenKeys = ["dose", "route", "schedule"];
const screeningRoles = new Set(["doctor", "pharmacist"]);

function documentedDirections(entry) {
  if (entry.directions) return entry.directions;
  const field = entry.scan_fields?.directions;
  const overrides = entry.label_overrides;
  if (field?.status === "readable" && overrides &&
    !overrides.includes("directions") && !overrides.includes("directions_status")) return field.value;
  return null;
}

export function admissionReview(encounter, row) {
  const entries = row.entries.filter(({ source }) =>
    !row.superseded.includes(source.id) && source.availability !== "unavailable"
  );
  const documentedSources = entries.filter(entry =>
    !reportKinds.has(entry.source.kind) &&
    entry.record_basis !== "documented_interview" &&
    entry.record_basis !== "discontinuation_order" &&
    (documentedDirections(entry) ||
      (entry.name && ["prescription", "label_photo", "reverse_photo"].includes(entry.source.kind)))
  );
  const documented = documentedSources.filter(entry => entry.source.source_date)
    .sort((a, b) => a.source.source_date.localeCompare(b.source.source_date)).at(-1)
    || documentedSources.at(-1);
  const accounts = entries.filter(entry =>
    reportKinds.has(entry.source.kind) || entry.record_basis === "documented_interview"
  );
  return {
    caseId: encounter.id,
    rowId: row.id,
    documented,
    documentedSources: documentedSources.filter(entry => documentedDirections(entry)),
    accounts,
    interview: row.interview,
    verified: row.verified,
    disputedSources: (row.disputed_identity_source_ids || []).map(id =>
      row.entries.find(entry => entry.source.id === id)
    ).filter(Boolean),
    incidents: Object.values(encounter.identity_incidents || {}).filter(incident => incident.row_id === row.id),
    screeningAttestation: activeAttestation(row, entries),
    missingRegimen: row.verified?.regimens?.length ? [] : missingRegimen(row.verified?.answer || row.interview),
    package: reviewPackage(encounter.capture, row),
  };
}

function missingRegimen(answer) {
  return regimenKeys.filter(key => !answer?.[key]);
}

function reviewableIdentity(entry) {
  return entry.name && (!entry.photo || (!entry.photo.appearance &&
    (entry.photo.front_attributed || entry.photo.pairing === "matched")));
}

function observedIdentityField(entry, key) {
  if (entry[key]) return entry[key];
  const scan = entry.scan_fields?.[key];
  if (scan?.status === "readable" && entry.label_overrides && !entry.label_overrides.includes(key)) return scan.value;
  return null;
}

function screeningIdentityIsSupported(row, entries, source) {
  const named = entries.filter(reviewableIdentity);
  const documents = named.filter(entry => !reportKinds.has(entry.source.kind));
  const identity = row.unknown
    ? entries.find(entry => entry.source.id === row.confirmed?.source_id)
    : documents.at(-1);
  if (!identity) return false;
  const product = entry => (entry.product || entry.name).trim().toLowerCase();
  if (!row.unknown) {
    if (new Set(documents.map(product)).size > 1) return false;
    for (const key of ["strength", "form"]) {
      const values = entries.map(entry => observedIdentityField(entry, key)).filter(Boolean);
      if (new Set(values.map(value => value.trim().toLowerCase())).size > 1) return false;
    }
  }
  const supported = [identity.name.trim().toLowerCase(), product(identity)];
  return (row.unknown ? [source] : named).every(entry => !entry.name || supported.includes(product(entry)));
}

function activeAttestation(row, entries) {
  const attestation = row.screening_attestation;
  if (!attestation || !row.interview) return null;
  const sameInterview = Object.entries(attestation.answer)
    .every(([key, value]) => value === row.interview[key]);
  const sameEvidence = attestation.active_sources.length === entries.length &&
    entries.every((entry, i) => entry.source.id === attestation.active_sources[i]);
  const sameIdentity = !row.unknown || (
    row.confirmed?.source_id === attestation.identity.source_id &&
    row.confirmed?.name === attestation.identity.name
  );
  return sameInterview && sameEvidence && sameIdentity ? attestation : null;
}

export function requiresPharmacyIdentity(row) {
  return row.unknown && !row.confirmed && Boolean(
    row.proposal || row.referred || ["current", "uncertain"].includes(row.interview?.current_use)
  );
}
export function canAttestCurrentUse(row, actor) {
  const answer = row.interview;
  if (!screeningRoles.has(actor.role) || row.verified || row.disputed_identity_source_ids?.length ||
    (row.unknown && !row.confirmed) ||
    answer?.ownership !== "patient" || answer.current_use !== "current" || !missingRegimen(answer).length) {
    return false;
  }
  const entries = row.entries.filter(entry => !row.superseded.includes(entry.source.id));
  const source = entries.find(entry => entry.source.id === answer.source_id);
  return Boolean(source && (reportKinds.has(source.source.kind) || source.record_basis === "documented_interview") &&
    screeningIdentityIsSupported(row, entries, source) && !activeAttestation(row, entries));
}

export function namedIdentityOptions(row) {
  const disputed = row.disputed_identity_source_ids || [];
  const candidates = row.entries.filter(entry => !row.superseded.includes(entry.source.id) && reviewableIdentity(entry));
  return candidates.filter(entry => {
    if (!disputed.length) return true;
    if (disputed.includes(entry.source.id) || !entry.identity_basis || reportKinds.has(entry.source.kind)) return false;
    return !row.entries.some(other => other !== entry && (disputed.includes(other.source.id) || candidates.includes(other)) &&
      ((entry.source.attachment_id && entry.source.attachment_id === other.source.attachment_id) ||
        (entry.photo?.data && entry.photo.data === other.photo?.data)));
  }).map(entry => [entry.source.id, [entry.product || entry.name, sourceLabel(entry.source), entry.wording].join(" · ")]);
}
function reviewPackage(capture, row) {
  const pkg = capture?.packages.find(({ id }) => id === row.package_id);
  const item = pkg?.items.find(({ row_id }) => row_id === row.capture_item_id);
  if (!item) return null;

  const front = item.evidence.filter(({ region }) => region.side === "front").map(({ region }) => region);
  const reverse = capture.reverse_matches
    .filter(match => match.package_id === pkg.id && match.status === "confirmed")
    .map(({ region }) => region);
  const views = [...front, ...reverse].map(link => {
    const view = capture[link.side];
    const region = view?.regions.find(({ id }) => id === link.region_id);
    if (!region || view.attachment_id !== link.attachment_id || view.revision !== link.revision) return null;
    return { link, opaque: view.visibility === "opaque" || region.visibility === "opaque" };
  }).filter(Boolean);
  const sources = item.evidence.map(evidence => ({
    ...evidence,
    source: capture.sources.find(({ id }) => id === evidence.source_id),
  }));
  return { id: pkg.id, item: item.row_id, views, sources };
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function sourceLabel(source) {
  return [
    source.organization || source.reporter || source.id,
    source.department_or_ward,
    source.source_date,
  ].filter(Boolean).join(" · ");
}

function renderPackage(root, pkg, loadCrop) {
  const details = element("details");
  details.className = "review-package";
  details.append(
    element("summary", `Open package regions · ${pkg.id}`),
    element("p", `Capture item ${pkg.item}`),
  );

  // A package match adds context. Only the row's own citations carry source claims.
  for (const evidence of pkg.sources) {
    if (evidence.source) {
      details.append(element("p", `${evidence.region.region_id} · ${evidence.kind} · ${sourceLabel(evidence.source)}`));
    }
  }
  if (!pkg.views.some(({ link }) => link.side === "front")) {
    details.append(element("p", "Front item region unavailable"));
  }
  if (!pkg.views.some(({ link }) => link.side === "reverse")) {
    details.append(element("p", "Reverse view missing or awaiting a confirmed match"));
  }

  const figures = element("div");
  figures.className = "grid";
  const requests = [];
  for (const { link, opaque } of pkg.views) {
    const side = link.side === "front" ? "Front item region" : "Confirmed reverse package region";
    const label = `${side} · ${link.region_id}`;
    const figure = element("figure");
    figure.append(element("figcaption", opaque ? `${label} · opaque` : label));
    if (!opaque) requests.push({ figure, link, label });
    figures.append(figure);
  }
  details.append(figures);
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    for (const { figure, link, label } of requests.splice(0)) {
      const status = element("p", "Loading region…");
      status.setAttribute("role", "status");
      figure.append(status);
      loadCrop(link).then(blob => {
        if (!figure.isConnected) return;
        const img = element("img");
        img.alt = label;
        img.className = "crop";
        const url = URL.createObjectURL(blob);
        const release = () => URL.revokeObjectURL(url);
        img.addEventListener("load", release, { once: true });
        img.addEventListener("error", () => {
          release();
          img.replaceWith(element("p", "Region unavailable. Reload the review to retry."));
        }, { once: true });
        img.src = url;
        status.replaceWith(img);
      }).catch(() => {
        status.textContent = "Region unavailable. Reload the review to retry.";
      });
    }
  });
  root.append(details);
}

export function regimenStatement(caseId, rowId, entry, basis) {
  const isPhoto = Boolean(entry.photo);
  const item = isPhoto ? {
    id: rowId,
    source_id: entry.source.id,
    row_id: rowId,
    kind: entry.source.kind === "reverse_photo" ? "matched_reverse_label" : "label_region",
  } : null;
  return {
    evidence: { case_id: caseId, sources: [entry.source], items: item ? [item] : [] },
    row_id: rowId,
    component_id: entry.source.id,
    basis,
    directions_text: basis === "documented" ? documentedDirections(entry) : entry.wording,
    source: { source_id: entry.source.id, item_id: item?.id ?? null },
  };
}

function renderSourcedRegimens(root, review, loadRegimens) {
  const clinicalReports = review.accounts.filter(entry => reportKinds.has(entry.source.kind));
  const statements = [
    ...review.documentedSources.map(entry => [entry, "documented"]),
    ...clinicalReports.map(entry => [entry, "reported"]),
  ];
  if (!statements.length) return;

  const details = element("details");
  details.className = "review-package";
  const output = element("div");
  details.append(element("summary", "Open sourced regimen fields"), output);
  root.append(details);

  details.addEventListener("toggle", async () => {
    if (!details.open || output.hasChildNodes()) return;
    const status = element("p", "Loading regimen fields…");
    status.setAttribute("role", "status");
    output.append(status);
    const results = await Promise.allSettled(statements.map(([entry, basis]) =>
      loadRegimens(regimenStatement(review.caseId, review.rowId, entry, basis))
    ));
    if (!details.isConnected) return;
    const components = results.flatMap(result =>
      result.status === "fulfilled" ? result.value.regimens : []
    );
    renderRegimenEvidence(output, components, statements.map(([entry]) => entry.source));
    if (results.some(result => result.status === "rejected")) {
      output.append(element("p", "Some regimen fields could not be loaded. The source wording is still available."));
    }
  });
}

function renderIdentityHistory(root, review, sourceName, assessIncident) {
  if (review.disputedSources.length && !review.verified) {
    root.append(element("strong", "Disputed documented identity"));
    for (const entry of review.disputedSources) {
      root.append(element("p", `${entry.name} · ${sourceName(entry.source.id)} · ${entry.wording}`));
    }
    root.append(element("p", "Link independent documentation for this physical item before verifying its identity."));
  }
  for (const incident of review.incidents) {
    const section = element("section");
    section.append(
      element("h4", "Original identity decision"),
      element("p", `${incident.decision} · ${incident.identity} · ${incident.reviewer.name} (${incident.reviewer.role}) · ${new Date(incident.recorded_at).toLocaleString()}`),
      element("p", incident.resolution),
    );
    for (const source of incident.conflicting_sources) {
      section.append(element("p", `Conflicting source · ${source.name} · ${sourceName(source.source_id)}`));
    }
    section.append(element("p", `Independent evidence · ${sourceName(incident.corroborating_source_id)}`));
    if (!incident.pharmacy_assessments.length) section.append(element("p", "Awaiting pharmacy assessment"));
    for (const assessment of incident.pharmacy_assessments) {
      section.append(element("p", `Pharmacy assessment · ${assessment.outcome.replaceAll("_", " ")} · ${assessment.assessment} · ${assessment.recorder.name} · ${new Date(assessment.recorded_at).toLocaleString()}`));
    }
    if (assessIncident) {
      const button = element("button", "Pharmacy assessment");
      button.type = "button";
      button.addEventListener("click", () => assessIncident(incident));
      section.append(button);
    }
    root.append(section);
  }
}

export function renderAdmissionReview(root, review, { loadCrop, loadRegimens, sourceName, assessIncident }) {
  const { documented, accounts, package: pkg } = review;
  const last = element("p");
  const directions = documented && documentedDirections(documented);
  last.append(
    element("strong", "Last documented prescription"),
    document.createTextNode(documented ? ` · ${directions || documented.directions_status || "Directions unavailable"} · ${sourceLabel(documented.source)}` : " · No prescription available"),
  );
  const reported = element("div");
  reported.append(element("strong", "Patient or caregiver account"));
  if (!accounts.length) reported.append(element("p", "No account recorded"));
  for (const account of accounts) {
    reported.append(element("p", `${account.wording} · ${sourceLabel(account.source)}`));
  }
  root.append(last, reported);
  renderIdentityHistory(root, review, sourceName, assessIncident);
  const attestation = review.screeningAttestation;
  if (attestation) {
    const status = element("p");
    status.append(
      element("strong", "Current use attested for screening"),
      document.createTextNode(
        ` · ${attestation.actor.name} (${attestation.actor.role}) · ${new Date(attestation.at).toLocaleString()} · Source ${sourceName(attestation.source_id)}`,
      ),
    );
    root.append(status);
    if (review.missingRegimen.length) {
      root.append(element("p", `Regimen still requires ${review.missingRegimen.join(", ")} before verification and import.`));
    }
  }
  renderSourcedRegimens(root, review, loadRegimens);
  if (pkg) renderPackage(root, pkg, loadCrop);
}
