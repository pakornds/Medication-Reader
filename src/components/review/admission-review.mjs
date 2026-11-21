import { renderRegimenEvidence } from "./regimen-editor.js";

const reportKinds = new Set(["patient_report", "caregiver_report"]);
const regimenKeys = ["dose", "route", "schedule"];
const screeningRoles = new Set(["doctor", "pharmacist"]);

export function admissionReview(encounter, row) {
  const entries = row.entries.filter(({ source }) =>
    !row.superseded.includes(source.id) && source.availability !== "unavailable"
  );
  const documentedSources = entries.filter(entry =>
    !reportKinds.has(entry.source.kind) &&
    entry.record_basis !== "documented_interview" &&
    entry.record_basis !== "discontinuation_order" &&
    (entry.name || entry.directions || entry.scan_fields?.directions)
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
    documentedSources: documentedSources.filter(entry => entry.directions),
    accounts,
    interview: row.interview,
    verified: row.verified,
    screeningAttestation: activeAttestation(row, entries),
    missingRegimen: missingRegimen(row.interview),
    package: reviewPackage(encounter.capture, row),
  };
}

function missingRegimen(answer) {
  return regimenKeys.filter(key => !answer?.[key]);
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
  if (!screeningRoles.has(actor.role) || row.verified || (row.unknown && !row.confirmed) ||
    answer?.ownership !== "patient" || answer.current_use !== "current" || !missingRegimen(answer).length) {
    return false;
  }
  const entries = row.entries.filter(entry => !row.superseded.includes(entry.source.id));
  return entries.some(entry => entry.source.id === answer.source_id) && !activeAttestation(row, entries);
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

function regimenStatement(caseId, rowId, entry, basis) {
  const isPhoto = Boolean(entry.photo);
  const item = isPhoto ? {
    id: "selected",
    source_id: entry.source.id,
    row_id: rowId,
    kind: entry.source.kind === "reverse_photo" ? "matched_reverse_label" : "label_region",
  } : null;
  return {
    evidence: { case_id: caseId, sources: [entry.source], items: item ? [item] : [] },
    row_id: rowId,
    component_id: entry.source.id,
    basis,
    directions_text: basis === "documented" ? entry.directions : entry.wording,
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

export function renderAdmissionReview(root, review, { loadCrop, loadRegimens, sourceName }) {
  const { documented, accounts, package: pkg } = review;
  const last = element("p");
  last.append(
    element("strong", "Last documented prescription"),
    document.createTextNode(documented ? ` · ${documented.directions || documented.directions_status || "Directions unavailable"} · ${sourceLabel(documented.source)}` : " · No prescription available"),
  );
  const reported = element("div");
  reported.append(element("strong", "Patient or caregiver account"));
  if (!accounts.length) reported.append(element("p", "No account recorded"));
  for (const account of accounts) {
    reported.append(element("p", `${account.wording} · ${sourceLabel(account.source)}`));
  }
  root.append(last, reported);
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
