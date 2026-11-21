const $ = (id) => document.getElementById(id);
let token = "",
  actor,
  catalogue = [],
  encounter,
  pending,
  saveForm;
const form = $("editform");
let scanDraft;
const clean = (value) => value?.trim() || null;
const human = (value) => (value || "").replaceAll("_", " ");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const id = () => crypto.randomUUID();
const active = (row) =>
  row.entries.filter((e) => !row.superseded.includes(e.source.id));
const role = () => actor.role === "pharmacist";
const title = (row) =>
  row.verified?.identity?.name ||
  row.confirmed?.name ||
  (row.unknown
    ? "Unknown medication " + row.id
    : active(row)
        .filter((e) => e.name)
        .at(-1)?.product || row.id);
const field = (label, name, value = "", type = "text", required = false) =>
  "<label>" +
  esc(label) +
  '<input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  (required ? "required" : "") +
  "></label>";
const area = (label, name, value = "", required = false) =>
  "<label>" +
  esc(label) +
  '<textarea name="' +
  name +
  '" ' +
  (required ? "required" : "") +
  ">" +
  esc(value) +
  "</textarea></label>";
const select = (label, name, options, value) =>
  "<label>" +
  esc(label) +
  '<select aria-label="' +
  esc(label) +
  '" name="' +
  name +
  '">' +
  options
    .map((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, human(o)];
      return (
        '<option value="' +
        esc(v) +
        '" ' +
        (v === value ? "selected" : "") +
        ">" +
        esc(t) +
        "</option>"
      );
    })
    .join("") +
  "</select></label>";
function button(text, action, row = "") {
  return (
    '<button type="button" data-action="' +
    action +
    '" data-row="' +
    esc(row) +
    '">' +
    esc(text) +
    "</button>"
  );
}
async function api(path, body, method) {
  const response = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Demo-Reviewer-Token": token,
    },
    body: body && JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.detail === "string"
        ? result.detail
        : Array.isArray(result.detail)
          ? result.detail.map((e) => e.msg).join(". ")
          : result.detail?.message || "Request failed",
    );
  return result;
}
function message(value) {
  $("message").textContent = value;
}
function screen(name) {
  for (const section of ["login", "queue", "workspace"])
    $(section).hidden = section !== name;
  message("");
}
async function queue() {
  const cases = await api("/admissions");
  encounter = null;
  pending = null;
  screen("queue");
  $("cases").innerHTML =
    cases
      .map(
        (c) =>
          "<p>" +
          button(c.patient_alias + " · " + c.status, "open", c.id) +
          " <time>" +
          esc(new Date(c.updated_at).toLocaleString()) +
          "</time></p>",
      )
      .join("") || "<p>No assigned encounters.</p>";
}
async function openCase(caseId) {
  encounter = await api("/admissions/" + encodeURIComponent(caseId));
  pending = null;
  screen("workspace");
  render();
}
$("signin").onsubmit = async (event) => {
  event.preventDefault();
  token = event.target.token.value;
  try {
    ({ actor, catalogue } = await api("/admissions/session"));
    event.target.reset();
    $("identity").textContent = actor.name;
    await queue();
  } catch (e) {
    token = "";
    message(e.message);
  }
};
$("signout").onclick = () => {
  token = "";
  actor = null;
  encounter = null;
  pending = null;
  saveForm = null;
  for (const elem of [
    "rows",
    "cases",
    "fields",
    "summary",
    "timeline",
    "identity",
    "controls",
  ])
    $(elem).replaceChildren();
  screen("login");
};
$("refresh").onclick = () => queue().catch((e) => message(e.message));
$("back").onclick = $("refresh").onclick;
$("reload").onclick = () =>
  openCase(encounter.id).catch((e) => message(e.message));
$("create").onsubmit = async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    encounter = await api("/admissions", {
      patient_alias: data.get("alias"),
      assigned_roles: data.getAll("role"),
    });
    event.target.reset();
    screen("workspace");
    render();
  } catch (e) {
    message(e.message);
  }
};
async function action(command) {
  const signature = JSON.stringify(command);
  if (
    !pending ||
    pending.signature !== signature ||
    pending.revision !== encounter.revision
  ) {
    pending = { signature, revision: encounter.revision, request_id: id() };
  }
  encounter = await api("/admissions/" + encounter.id + "/actions", {
    revision: pending.revision,
    request_id: pending.request_id,
    command,
  });
  pending = null;
  render();
  if (command.action === "import") {
    const at = encounter.receipts
      .at(-1)
      .imported_at.replace(
        /(?:\.(\d+))?(?:Z|\+00:00)$/,
        (_, f = "") => "." + f.padEnd(6, "0") + "Z",
      );
    try {
      localStorage.setItem("medication-reader:imported-at:" + at, at);
    } catch {
      message("Imported. Timestamp history is unavailable in this browser.");
    }
  }
}
function canSelectForImport(row) {
  const review = row.verified;
  return !row.imported_at && review?.identity
    && review.answer.ownership === "patient" && review.answer.current_use !== "not_owned";
}
function edit(title, fields, save) {
  scanDraft = null;
  form.querySelector('[type=submit]').textContent = ({
    "Finish reconciliation": "Finish reconciliation",
    "Request pharmacist review": "Send referral",
    "Approve and import selected rows": "Approve and import selected rows",
  })[title] || "Save";
  form.querySelector("h2").textContent = title;
  $("fields").innerHTML = fields;
  $("formerror").textContent = "";
  saveForm = save;
  $("editor").showModal();
}
$("cancel").onclick = () => $("editor").close();
form.onsubmit = async (event) => {
  event.preventDefault();
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    await saveForm(new FormData(form));
    $("editor").close();
  } catch (e) {
    $("formerror").textContent = e.message;
  } finally {
    submit.disabled = false;
  }
};
const get = (data, key) => clean(data.get(key));
const locationFields =
  '<div class="grid">' +
  ["x", "y", "width", "height"]
    .map((n, i) => field(n + " (%)", n, i < 2 ? "0" : "100", "number"))
    .join("") +
  "</div>";
async function photoData(file) {
  if (!file?.size || file.size > 4000000)
    throw new Error("Choose a PNG, JPEG or WebP photo under 4 MB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}
function evidenceForm(row, retake) {
  const sourceId = id();
  const photos = row ? active(row).filter((e) => e.photo) : [];
  edit(
    row
      ? retake
        ? "Retake item photo"
        : "Link evidence to " + title(row)
      : "Add medication or unknown item",
    select(
      "Evidence type",
      "kind",
      [
        "transfer_record",
        "label_photo",
        "reverse_photo",
        "additional_photo",
        "prescription",
        "patient_report",
        "caregiver_report",
        "reviewer_record",
      ],
      retake ? "reverse_photo" : undefined,
    ) +
      field("Source, reporter or department", "reporter", "", "text", true) +
      field("Source date, if known", "date", "", "date") +
      '<fieldset id="photo"><legend>Photo evidence</legend><p>Photograph the labels first. Flip items in place. For moved or overlapping items, keep the match open and retake that item.</p>' +
      '<label>Item photo<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label>' +
      field("Bag or package reference", "bag") +
      field("Distinct tablet appearance, if a crop", "appearance") +
      locationFields +
      '<label id="front-attribution"><input type="checkbox" name="front_attributed"> This front label region belongs to the selected bag.</label>' +
      select("Pairing", "pairing", ["uncertain", "matched"]) +
      button("Read selected label region", "scan") +
      "</fieldset>" +
      (retake
        ? select(
            "Photo to replace",
            "replaces",
            photos.map((e) => [e.source.id, e.photo.bag + " · " + e.wording]),
          )
        : "") +
      area("Original wording or observation", "wording", "", true) +
      field("Documented medicine name", "name") +
      '<div id="scan-names"></div>' +
      field("Documented strength", "strength") +
      field("Dosage form", "form") +
      field("Printed dose", "dose") +
      select("Record excerpt type", "record_basis", [
        ["", "Medication list or other evidence"],
        ["documented_interview", "Documented prior interview"],
        ["discontinuation_order", "Documented discontinuation order"],
      ]) +
      field("Patient name printed on label", "label_owner") +
      field("Printed directions", "directions") +
      select("If directions are blank", "directions_status", [
        "missing",
        "unreadable",
      ]) +
      field("Documented indication", "indication") +
      (row?.unknown
        ? select(
            "Independent identity evidence, if documented",
            "identity_basis",
            [
              ["", "No independent confirmation"],
              "matched_original_package",
              "dispensing_confirmation",
              "item_specific_record",
            ],
          )
        : "") +
      (row
        ? '<label><input type="checkbox" name="confirmed" required> I confirm this evidence belongs to this order or bag.</label>'
        : ""),
    async (data) => {
      const kind = data.get("kind"),
        photo = kind.endsWith("photo");
      const entry = {
        source: {
          id: scanDraft.source,
          kind,
          reporter: get(data, "reporter"),
          source_date: get(data, "date"),
        },
        wording: get(data, "wording"),
        scan_fields: scanDraft?.fields || {},
      };
      for (const key of [
        "name",
        "identity_basis",
        "strength",
        "form",
        "dose",
        "record_basis",
        "label_owner",
        "directions",
        "indication",
        "directions_status",
      ])
        entry[key] = get(data, key);
      if (photo) {
        const file = data.get("image");
        entry.photo = {
          data: await photoData(file),
          media_type: file.type,
          bag: get(data, "bag"),
          pairing: data.get("pairing"),
          front_attributed: kind === "label_photo" && data.has("front_attributed"),
          appearance: get(data, "appearance"),
          region: ["x", "y", "width", "height"].map(
            (k) => Number(data.get(k)) / 100,
          ),
        };
      }
      await action(
        row
          ? {
              action: "link",
              row_id: row.id,
              entry,
              confirmed: true,
              replaces: get(data, "replaces"),
            }
          : { action: "add", entry },
      );
    },
  );
  const update = () => {
    $("photo").hidden = !form.elements.kind.value.endsWith("photo");
    $("front-attribution").style.display = form.elements.kind.value === "label_photo" ? "" : "none";
    form.elements.pairing.closest("label").style.display = form.elements.kind.value === "label_photo" ? "none" : "";
  };
  scanDraft = { source: sourceId, fields: {}, filled: {}, revision: 0 };
  form.elements.name.oninput = () => {
    delete scanDraft.filled.name;
    const choice = form.elements.namedItem("scan_name");
    if (choice) choice.value = "";
  };
  const resetScan = () => {
    const draft = scanDraft;
    draft.revision++;
    for (const [key, value] of Object.entries(draft.filled)) {
      const control = form.elements.namedItem(key);
      if (control.value === value)
        control.value = key === "directions_status" ? "missing" : "";
    }
    draft.filled = {};
    draft.fields = {};
    $("scan-names").replaceChildren();
  };
  for (const key of [
    "image",
    "bag",
    "appearance",
    "x",
    "y",
    "width",
    "height",
    "pairing",
    "front_attributed",
  ]) {
    form.elements.namedItem(key).oninput = () => {
      resetScan();
      scanDraft.source = id();
      if (["image", "bag", "x", "y", "width", "height"].includes(key)) {
        form.elements.front_attributed.checked = false;
        form.elements.pairing.value = "uncertain";
      }
    };
  }
  form.elements.kind.onchange = () => {
    resetScan();
    scanDraft.source = id();
    form.elements.front_attributed.checked = false;
    form.elements.pairing.value = "uncertain";
    update();
  };
  update();
}
async function scan() {
  const f = new FormData(form),
    file = f.get("image"),
    kind = f.get("kind");
  const attributed = kind === "label_photo" ? f.has("front_attributed") : f.get("pairing") === "matched";
  if (!attributed || get(f, "appearance"))
    throw new Error("Match the label region to this item first.");
  const draft = scanDraft,
    revision = ++draft.revision;
  const source = draft.source,
    rid = "preview",
    region = "selected";
  const metadata = {
    evidence: {
      case_id: encounter.id,
      sources: [{ id: source, kind }],
      items: [
        {
          id: region,
          row_id: rid,
          source_id: source,
          kind:
            kind === "reverse_photo" ? "matched_reverse_label" : "label_region",
        },
      ],
    },
    photo_source_ids: [source],
    region_locations: {
      [source]: {
        [region]: ["x", "y", "width", "height"]
          .map((k) => f.get(k) + "%")
          .join(", "),
      },
    },
  };
  const multipart = new FormData();
  multipart.append("form", JSON.stringify(metadata));
  multipart.append("photos", file);
  const resp = await fetch("/medication-analysis", {
    method: "POST",
    body: multipart,
    cache: "no-store",
  });
  const body = await resp.json();
  if (
    !form.closest("dialog").open ||
    scanDraft !== draft ||
    draft.revision !== revision
  )
    return;
  if (!resp.ok)
    throw new Error(
      body.detail?.message || "Read the label manually or retry.",
    );
  const row = body.rows.find((r) => r.id === rid);
  if (!row) throw new Error("No supported transcription for this region.");
  $("formerror").textContent = "";
  draft.fields = row.label_fields;
  const names = [...new Set(
    row.observed_names
      .filter(({ evidence }) => evidence.source_id === source && evidence.item_id === region)
      .map(({ value }) => value),
  )];
  const previousSelection = form.elements.namedItem("scan_name")?.value;
  const selectedName = names.includes(previousSelection) ? previousSelection : "";
  $("scan-names").innerHTML = names.length > 1
    ? select("Name observed in this region", "scan_name", [
        ["", "Choose a name or leave it unresolved"],
        ...names.map((name) => [name, name]),
      ], selectedName)
    : "";
  const choice = form.elements.namedItem("scan_name");
  if (choice) {
    choice.onchange = () => {
      form.elements.name.value = choice.value;
      draft.filled.name = choice.value;
    };
  }
  const values = { name: names.length === 1 ? names[0] : selectedName };
  for (const key of ["strength", "form", "dose", "directions", "indication"])
    values[key] = row.label_fields[key]?.value;
  values.wording = [
    ...new Set(
      [
        ...names,
        ...Object.values(row.label_fields).map((f) => f.value),
      ].filter(Boolean),
    ),
  ].join("\n");
  values.directions_status = row.label_fields.directions?.status === "unreadable" ? "unreadable" : "missing";
  for (const [key, value] of Object.entries(values)) {
    const input = form.elements.namedItem(key);
    const owned = Object.hasOwn(draft.filled, key) && input.value === draft.filled[key];
    const defaultStatus = key === "directions_status" && !Object.hasOwn(draft.filled,key) && input.value === "missing";
    if (owned || !input.value || defaultStatus) {
      input.value = value || "";
      draft.filled[key] = input.value;
    }
  }
}
function sourceOptions(row) {
  return active(row).map((e) => [
    e.source.id,
    human(e.source.kind) + " · " + e.wording,
  ]);
}
function interview(row) {
  const old = row.interview || {};
  const labels = active(row)
    .map((e) => e.label_owner?.trim().toLowerCase())
    .filter(Boolean);
  const owner =
    labels.length &&
    labels.every((n) => n === encounter.patient_alias.trim().toLowerCase())
      ? "patient"
      : "uncertain";
  const options = active(row)
    .filter(
      (e) =>
        ["patient_report", "caregiver_report"].includes(e.source.kind) ||
        e.record_basis,
    )
    .map((e) => [e.source.id, human(e.source.kind) + " · " + e.wording]);
  edit(
    "Patient interview · " + title(row),
    select(
      "Interview evidence",
      "source_id",
      [["new", "New interview answer"], ...options],
      old.source_id,
    ) +
      '<fieldset id="newanswer"><legend>New interview source</legend>' +
      select("Account from", "kind", ["patient_report", "caregiver_report"]) +
      field("Reporter", "reporter") +
      area("Original account", "wording") +
      "</fieldset>" +
      select(
        "Ownership",
        "ownership",
        ["uncertain", "patient", "other"],
        old.ownership || owner,
      ) +
      select(
        "Current use",
        "current_use",
        [
          "uncertain",
          "current",
          "reported_stopped",
          "discontinued_order",
          "not_owned",
        ],
        old.current_use,
      ) +
      field("Actual dose", "dose", old.dose) +
      field("Actual route", "route", old.route) +
      field("Actual schedule or as-needed use", "schedule", old.schedule) +
      field("Reason for use, as reported", "reason", old.reason) +
      area(
        "Clinician suspected DRP or handoff note (optional)",
        "note",
        old.note,
      ),
    async (data) => {
      let sid = data.get("source_id");
      if (sid === "new") {
        const wording = get(data, "wording"),
          reporter = get(data, "reporter");
        if (!wording || !reporter)
          throw new Error("Record the original account and its reporter.");
        sid = newSid;
        await action({
          action: "link",
          row_id: row.id,
          confirmed: true,
          entry: {
            source: {
              id: sid,
              kind: data.get("kind"),
              reporter,
              source_date: new Date().toISOString().slice(0, 10),
            },
            wording,
          },
        });
        form.elements.source_id.add(new Option(wording, sid, true, true));
        form.elements.source_id.onchange();
      }
      const ownerLabel = active(row).find(
        (e) =>
          e.label_owner?.trim().toLowerCase() ===
          encounter.patient_alias.trim().toLowerCase(),
      );
      const cmd = {
        action: "interview",
        row_id: row.id,
        source_id: sid,
        ownership_source_id:
          !old.ownership &&
          owner === "patient" &&
          data.get("ownership") === "patient"
            ? ownerLabel.source.id
            : sid,
      };
      for (const key of [
        "ownership",
        "current_use",
        "dose",
        "route",
        "schedule",
        "reason",
        "note",
      ])
        cmd[key] = get(data, key);
      await action(cmd);
    },
  );
  const newSid = id();
  form.elements.source_id.onchange = () =>
    ($("newanswer").hidden = form.elements.source_id.value !== "new");
  form.elements.source_id.onchange();
}
function crop(canvas, photo) {
  const img = new Image();
  img.onload = () => {
    const [x, y, w, h] = photo.region;
    canvas.width = Math.max(1, Math.round(img.width * w));
    canvas.height = Math.max(1, Math.round(img.height * h));
    canvas
      .getContext("2d")
      .drawImage(
        img,
        img.width * x,
        img.height * y,
        img.width * w,
        img.height * h,
        0,
        0,
        canvas.width,
        canvas.height,
      );
  };
  img.src = "data:" + photo.media_type + ";base64," + photo.data;
}
function render() {
  const sourceNames = new Map();
  for (const row of Object.values(encounter.rows)) {
    row.entries.forEach((entry, i) =>
      sourceNames.set(entry.source.id, row.id + " / source " + (i + 1)),
    );
  }
  const sourceName = (sid) => sourceNames.get(sid) || sid;
  const rows = Object.values(encounter.rows),
    finished = encounter.status === "Finished";
  const writable = !finished && (encounter.status === "In progress" || role());
  $("summary").innerHTML =
    "<h2>" +
    esc(encounter.patient_alias) +
    '</h2><p class="status">' +
    esc(encounter.status) +
    "</p><p>" +
    esc(
      new Date(
        encounter.events.at(-1)?.at || encounter.created_at,
      ).toLocaleString(),
    ) +
    " · Revision " +
    encounter.revision +
    '</p><h2 class="paper">' +
    (finished
      ? "Reviewed medication handoff"
      : "Admission interview worksheet") +
    "</h2>";
  $("start").hidden = !writable || !rows.length;
  $("print").hidden = !rows.length;
  $("print").textContent = finished
    ? "Print reviewed handoff"
    : "Print worksheet";
  $("rows").innerHTML = rows
    .map((row) => {
      const answer = row.interview,
        verification = row.verified;
      const state = row.confirmed
        ? "Identity confirmed by pharmacist"
        : row.proposal
          ? "Proposed identity — pharmacist review required"
          : row.unknown
            ? "Unresolved identity"
            : "Documented identity";
      const sources = row.entries
        .map(
          (e, i) =>
            '<div class="source"><strong>' +
            esc(human(e.source.kind)) +
            "</strong> · " +
            esc(e.source.reporter || "") +
            " " +
            esc(e.source.source_date || "") +
            (row.superseded.includes(e.source.id)
              ? " · Replaced on retake"
              : "") +
            "<br>" +
            esc(e.wording).replaceAll("\n", "<br>") +
            "<br><small>Source " +
            esc(sourceName(e.source.id)) +
            "</small>" +
            (e.photo
              ? "<p>" +
                esc(e.photo.bag) +
                " · " +
                esc(e.photo.appearance || "Label region") +
                " · " +
                (e.photo.front_attributed
                  ? "Attributed front region"
                  : e.photo.pairing === "matched"
                  ? "Matched"
                  : "Uncertain pairing · targeted retake needed") +
                "</p>" +
                (e.photo.front_attributed || e.photo.pairing === "matched"
                  ? '<canvas class="crop" data-item="' +
                    row.id +
                    '" data-index="' +
                    i +
                    '"></canvas>'
                  : "")
              : "") +
            (Object.keys(e.scan_fields || {}).length
              ? "<p>Scanned label · " +
                Object.entries(e.scan_fields)
                  .map(
                    ([k, v]) =>
                      esc(human(k)) + " — " + esc(v.value || v.status),
                  )
                  .join(" · ") +
                "</p>"
              : "") +
            (e.label_owner
              ? "<p>Printed owner · " + esc(e.label_owner) + "</p>"
              : "") +
            (["patient_report", "caregiver_report"].includes(e.source.kind)
              ? ""
              : "<p>Documented directions · " +
                esc(e.directions || e.directions_status) +
                "<br>Documented indication · " +
                esc(e.indication || "missing") +
                "</p>") +
            "</div>",
        )
        .join("");
      const anotherStrength = rows.some(
        (r) =>
          r !== row && !row.unknown && !r.unknown &&
          /\d/.test(title(row)) &&
          title(r).split(/\s*\d/)[0] === title(row).split(/\s*\d/)[0] &&
          title(r) !== title(row),
      );
      return (
        "<article><h3>" +
        esc(title(row)) +
        "</h3><p>" +
        esc(row.id) +
        " · " +
        esc(state) +
        (row.proposal
          ? " · " +
            esc(
              row.proposal.name +
                " (" +
                sourceName(row.proposal.reference) +
                ", " +
                row.proposal.proposer +
                ")",
            )
          : "") +
        "</p>" +
        sources +
        (anotherStrength
          ? "<p>Suggested follow-up · Clarify how the patient currently uses each strength, including any as-needed use.</p>"
          : "") +
        (answer
          ? "<p><strong>Interview</strong> · " +
            esc(human(answer.ownership)) +
            " (source " +
            esc(sourceName(answer.ownership_source_id || answer.source_id)) +
            ") · " +
            esc(human(answer.current_use)) +
            " · " +
            esc(
              [answer.dose, answer.route, answer.schedule]
                .filter(Boolean)
                .join(" "),
            ) +
            "<br>Reason for use · " +
            esc(answer.reason || "Unknown") +
            " · Source " +
            esc(sourceName(answer.source_id)) +
            (answer.note ? "<br>Clinician note · " + esc(answer.note) : "") +
            "</p>"
          : "<p>Interview pending</p>") +
        (verification
          ? "<p><strong>Verified use</strong> · " +
            esc(human(verification.answer.current_use)) +
            " · " +
            esc(verification.actor.name) +
            " · " +
            esc(new Date(verification.at).toLocaleString()) +
            " · " +
            esc(sourceName(verification.source_id)) +
            (verification.identity
              ? "<br>Verified identity · " +
                esc(verification.identity.name) +
                " · " +
                esc(sourceName(verification.identity.source_id))
              : "") +
            (verification.resolution
              ? "<br>Conflict resolution · " + esc(verification.resolution)
              : "") +
            "</p>"
          : "<p>Verification pending</p>") +
        (row.imported_at
          ? "<p>Already imported · " + esc(new Date(row.imported_at).toLocaleString()) + "</p>"
          : "") +
        '<div class="bar">' +
        (writable
          ? button("Link source or photo", "link", row.id) +
            button("Interview", "interview", row.id) +
            (active(row).some((e) => e.photo)
              ? button("Targeted retake", "retake", row.id)
              : "") +
            (row.unknown ? button("Propose identity", "propose", row.id) : "") +
            (row.unknown && role()
              ? button("Review identity", "decide", row.id)
              : "") +
            (answer ? button("Verify current use", "verify", row.id) : "")
          : "") +
        "</div>" +
        (!finished
          ? '<div class="paper"><p class="writing">Ownership and current use</p><p class="writing">Actual regimen and reason for use</p><p class="writing">Follow-up or handoff note</p></div>'
          : "") +
        "</article>"
      );
    })
    .join("");
  for (const canvas of document.querySelectorAll(".crop"))
    crop(
      canvas,
      encounter.rows[canvas.dataset.item].entries[Number(canvas.dataset.index)]
        .photo,
    );
  $("controls").innerHTML =
    '<div class="bar">' +
    (writable ? button("Add medication or unknown item", "add") : "") +
    (writable && rows.length ? button("Finish reconciliation", "finish") : "") +
    (encounter.status === "In progress" &&
    rows.some((r) => r.unknown && !r.confirmed)
      ? button("Request pharmacist review", "refer")
      : "") +
    (role() && rows.some(canSelectForImport)
      ? button("Approve and import selected rows", "import")
      : "") +
    "</div>";
  const finishButton = $("controls").querySelector('[data-action="finish"]');
  if (finishButton)
    finishButton.disabled = rows.some(
      (r) => !r.verified || r.proposal || r.referred,
    );
  $("timeline").innerHTML =
    "<h3>Review record</h3>" +
    encounter.events
      .map(
        (e) =>
          (["verify", "finish", "refer", "decide", "propose"].includes(e.action)
            ? "<p>"
            : '<p class="screen">') +
          esc(new Date(e.at).toLocaleString()) +
          " · " +
          esc(e.actor.name) +
          " · " +
          esc(human(e.action)) +
          " · " +
          esc(e.rows.join(", ")) +
          (e.checked
            ? "<br>Checked · " +
              esc(e.checked) +
              " · Referral reason · " +
              esc(e.reason)
            : "") +
          (e.finding
            ? "<br>" +
              esc([e.outcome, e.name, e.finding].filter(Boolean).join(" · "))
            : "") +
          (e.proposal
            ? "<br>" + esc(e.proposal.name + " · " + e.proposal.reference)
            : "") +
          (e.sources?.length
            ? " · " + esc(e.sources.map(sourceName).join(", "))
            : "") +
          "</p>",
      )
      .join("");
}
$("start").onclick = () =>
  interview(
    Object.values(encounter.rows).find((r) => !r.interview) ||
      Object.values(encounter.rows)[0],
  );
$("print").onclick = () => window.print();
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-action]");
  if (!b) return;
  const op = b.dataset.action,
    row = encounter?.rows[b.dataset.row];
  try {
    if (op === "open") return await openCase(b.dataset.row);
    if (op === "scan") {
      b.disabled = true;
      try {
        await scan();
      } finally {
        b.disabled = false;
      }
      return;
    }
    if (op === "add" || op === "link" || op === "retake")
      return evidenceForm(row, op === "retake");
    if (op === "interview") return interview(row);
    if (op === "verify")
      return edit(
        "Verify current use · " + title(row),
        "<p>" +
          esc(
            [
              row.interview.current_use,
              row.interview.dose,
              row.interview.route,
              row.interview.schedule,
            ]
              .filter(Boolean)
              .join(" · "),
          ) +
          "</p>" +
          (row.unknown
            ? ""
            : select(
                "Identity evidence",
                "identity_source_id",
                active(row)
                  .filter((e) => e.name)
                  .map((e) => [e.source.id, e.product + " · " + e.source.id]),
              )) +
          area(
            "Resolution of conflicting sources, if applicable",
            "resolution",
          ),
        (f) =>
          action({
            action: op,
            row_id: row.id,
            source_id: row.interview.source_id,
            identity_source_id: get(f, "identity_source_id"),
            resolution: get(f, "resolution"),
          }),
      );
    if (op === "propose") {
      const records = await api("/admissions/" + encounter.id + "/candidates");
      const choices = [
        ...records,
        ...catalogue.map((c) => ({ ...c, origin: "Catalogue" })),
      ];
      edit(
        "Propose identity · " + row.id,
        select("Hospital record or catalogue candidate", "candidate", [
          ["", "Free text"],
          ...choices.map((c) => [
            c.id,
            c.origin + " · " + c.name + " · " + c.id,
          ]),
        ]) +
          field("Search local Thai catalogue", "query") +
          button("Search catalogue", "tmt") +
          field("Proposed identity", "name", "", "text", true) +
          field("Source or lookup reference", "reference", "", "text", true),
        (f) =>
          action({
            action: op,
            row_id: row.id,
            name: get(f, "name"),
            reference: get(f, "reference"),
          }),
      );
      const search = form.querySelector('[data-action="tmt"]');
      search.onclick = async () => {
        const query = form.elements.query.value.trim();
        if (!query) return;
        search.disabled = true;
        try {
          const result = await api(
            "/checks/local/products?q=" + encodeURIComponent(query),
          );
          for (const product of result.products) {
            const reference = "TMT " + result.tmt_release + " / " + product.tpu;
            if (!choices.some((c) => c.id === reference)) {
              choices.push({ id: reference, name: product.label });
              form.elements.candidate.add(
                new Option(product.label + " · " + reference, reference),
              );
            }
          }
          $("formerror").textContent = result.products.length
            ? "Choose a catalogue result above."
            : "No match. Enter a proposed name and reference.";
        } catch (err) {
          $("formerror").textContent =
            err.message + " Free-text proposals are available.";
        } finally {
          search.disabled = false;
        }
      };
      form.elements.candidate.onchange = () => {
        const c = choices.find((v) => v.id === form.elements.candidate.value);
        if (c) {
          form.elements.name.value = c.name;
          form.elements.reference.value = c.id;
        }
      };
      return;
    }
    if (op === "decide")
      return edit(
        "Pharmacist identity review · " + row.id,
        select("Decision", "outcome", [
          "pending",
          "confirm",
          "correct",
          "reject",
        ]) +
          select("Item-specific evidence", "source_id", sourceOptions(row)) +
          field("Documented identity", "name", row.proposal?.name) +
          area("Evidence checked and finding", "finding", "", true),
        (f) =>
          action({
            action: op,
            row_id: row.id,
            outcome: f.get("outcome"),
            source_id: f.get("source_id"),
            name: get(f, "name"),
            finding: get(f, "finding"),
          }),
      );
    if (op === "finish")
      return edit(
        "Finish reconciliation",
        "<p>Record the dated clinical review for this encounter.</p>",
        () => action({ action: op }),
      );
    if (op === "refer" || op === "import") {
      const rows = Object.values(encounter.rows);
      const choices = rows.filter((r) =>
        op === "refer" ? r.unknown && !r.confirmed : canSelectForImport(r),
      );
      edit(
        b.textContent,
        choices
          .map(
            (r) =>
              '<label><input type="checkbox" name="row" value="' +
              r.id +
              '"> ' +
              esc(title(r)) +
              " · " +
              r.id +
              "</label>",
          )
          .join("") +
          (op === "refer"
            ? area("What has been checked", "checked", "", true) +
              area("Reason for referral", "reason", "", true)
            : rows.filter((r) => r.imported_at)
                .map((r) => "<p>" + esc(title(r)) + " · Already imported</p>")
                .join("")),
        (f) =>
          action({
            action: op,
            row_ids: f.getAll("row"),
            ...(op === "refer"
              ? { checked: get(f, "checked"), reason: get(f, "reason") }
              : {}),
          }),
      );
    }
  } catch (e) {
    if ($("editor").open) $("formerror").textContent = e.message;
    else message(e.message);
  }
});
