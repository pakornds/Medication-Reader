const descriptors = ["imprint", "shape", "form", "color"];

async function lookupCandidates(request, signal) {
  const response = await fetch("/pill-candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error("Candidate lookup failed");
  return response.json();
}

function textElement(document, tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function featureList(document, title, features) {
  const section = document.createElement("div");
  section.append(textElement(document, "h5", title));
  if (!features.length) {
    section.append(textElement(document, "p", "None recorded."));
    return section;
  }

  const list = document.createElement("ul");
  for (const feature of features) list.append(textElement(document, "li", feature));
  section.append(list);
  return section;
}

function referenceCard(document, candidate) {
  const card = document.createElement("article");
  card.append(textElement(document, "h4", `${candidate.fictional_medication} (${candidate.reference_id})`));
  // Candidate image references are server-owned paths in the synthetic catalog.
  const imagePath = `/pill-candidates/references/${encodeURIComponent(candidate.reference_id)}`;
  if (candidate.image_reference === imagePath) {
    const image = document.createElement("img");
    image.src = imagePath;
    image.alt = `Reference appearance for ${candidate.reference_id}`;
    card.append(image);
  }
  card.append(featureList(document, "Matching features", candidate.matches));
  card.append(featureList(document, "Conflicting features", candidate.differences));
  return card;
}

/** Mount a comparison for one matched crop. Dispose before changing the row or photo. */
export function mountCandidateComparison(container, { request, cropUrl, lookup = lookupCandidates }) {
  const document = container.ownerDocument;
  const observation = request.observation;
  const panel = document.createElement("section");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const results = document.createElement("div");
  const form = document.createElement("form");
  const fields = new Map();
  let inFlight;

  panel.append(textElement(document, "h3", "Loose-pill candidate comparison"));
  if (cropUrl) {
    const crop = document.createElement("img");
    crop.src = cropUrl;
    crop.alt = "Matched crop of the observed item";
    panel.append(crop);
  } else {
    panel.append(textElement(document, "p", "Matched crop image unavailable."));
  }
  panel.append(textElement(document, "p", "Identity unresolved. Confirm identity with independent evidence."));

  const group = document.createElement("fieldset");
  group.append(textElement(document, "legend", "Observed features"));
  for (const name of descriptors) {
    const label = textElement(document, "label", name[0].toUpperCase() + name.slice(1));
    const input = document.createElement("input");
    input.name = name;
    input.value = observation[name].value ?? "";
    input.placeholder = observation[name].status === "unreadable" ? "Unreadable" : "Unknown";
    fields.set(name, input);
    label.append(input);
    group.append(label);
  }
  const refresh = textElement(document, "button", "Refresh candidates");
  refresh.type = "submit";
  form.append(group, refresh);
  panel.append(form, status, results);
  container.replaceChildren(panel);

  function cancelLookup() {
    inFlight?.abort();
    inFlight = undefined;
  }

  form.addEventListener("input", () => {
    cancelLookup();
    results.replaceChildren();
    status.textContent = "Observed features changed. Refresh candidates to compare again.";
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    cancelLookup();
    const controller = new AbortController();
    inFlight = controller;
    results.replaceChildren();
    status.textContent = "Checking synthetic references…";

    const edited = { ...observation };
    for (const [name, input] of fields) {
      const value = input.value.trim();
      if (value === (observation[name].value ?? "")) continue;
      edited[name] = value ? { status: "readable", value, evidence: observation.crop } : { status: "missing" };
    }

    try {
      const result = await lookup({ ...request, observation: edited }, controller.signal);
      if (inFlight !== controller) return;
      if (result.row_id !== observation.row_id || result.status !== "unresolved") {
        throw new Error("Candidate result does not belong to this comparison");
      }
      const cards = result.candidates.map(candidate => referenceCard(document, candidate));
      if (cards.length) results.append(textElement(document, "h3", "Synthetic references"), ...cards);
      status.textContent = result.follow_up;
    } catch {
      if (inFlight !== controller) return;
      status.textContent = "Candidate lookup failed. Refresh to try again.";
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  });

  return () => {
    cancelLookup();
    panel.remove();
  };
}
