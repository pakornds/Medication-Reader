import {PackageLayout, boundsBetween, displayPoint} from "./layout.mjs";

const titles = {front: "Photo 1 · Labels up", reverse: "Photo 2 · Backs up"};
const percent = value => value * 100 + "%";
const packageName = id => "Package " + id.slice("package-".length);
const regionName = (side, id) => (side === "front" ? "Front " : "Back ") + id.slice(side.length + 1);

function positionBox(node, {x, y, width, height}) {
  Object.assign(node.style, {left: percent(x), top: percent(y), width: percent(width), height: percent(height)});
}

/** Mount once per encounter. The caller owns the original image URLs and their lifetime. */
export function mountPackageLayout(container, {caseId, onChange = () => {}}) {
  const doc = container.ownerDocument;
  const layout = new PackageLayout(caseId);
  const urls = {};
  const selected = {front: null, reverse: null};
  const zoom = {front: 1, reverse: 1};
  const pan = {front: false, reverse: false};
  let activePackage, previewReverse, guide = false;

  function el(tag, text, className) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action) {
    const node = el("button", text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function option(value, label) {
    const node = el("option", label);
    node.value = value;
    return node;
  }
  function select(label, choices, value, action) {
    const wrapper = el("label", label + " ");
    const field = el("select");
    field.setAttribute("aria-label", label);
    for (const [key, text] of choices) field.append(option(key, text));
    field.value = value ?? "";
    field.addEventListener("change", () => action(field.value));
    wrapper.append(field);
    return wrapper;
  }
  function shallowImage(side, alt) {
    const image = el("img");
    image.src = urls[side];
    image.alt = alt;
    image.draggable = false;
    return image;
  }
  function choose(side, id) {
    selected[side] = id;
    if (side === "front") {
      activePackage = layout.packages.find(pkg => pkg.frontId === id)?.id;
      previewReverse = undefined;
    } else previewReverse = id;
  }
  function notify() {
    render();
    onChange(layout.snapshot(), {hiddenPackageIds: layout.packages.filter(pkg => pkg.status === "hidden").map(pkg => pkg.id)});
  }
  function commitBox(side, bounds, editing) {
    if (editing) layout.edit(side, editing, bounds);
    const id = editing ?? layout.add(side, bounds);
    choose(side, id);
    notify();
  }
  function wireDrawing(stage, side) {
    let start, ghost, pointer, editing;
    function reset() {
      ghost?.remove();
      ghost = start = pointer = editing = undefined;
    }
    stage.addEventListener("pointerdown", event => {
      if (event.button !== 0 || pointer !== undefined || pan[side] || !stage.clientHeight || !stage.isConnected) return;
      const point = displayPoint(stage.getBoundingClientRect(), event.clientX, event.clientY);
      editing = event.target.dataset.resize;
      start = editing ? layout.region(side, editing).bounds : point;
      pointer = event.pointerId;
      stage.setPointerCapture(pointer);
      ghost = el("span", "", "pl-box pl-drawing");
      stage.append(ghost);
      positionBox(ghost, boundsBetween(start, start));
    });
    function current(event) {
      return boundsBetween(start, displayPoint(stage.getBoundingClientRect(), event.clientX, event.clientY));
    }
    stage.addEventListener("pointermove", event => {
      if (event.pointerId === pointer) positionBox(ghost, current(event));
    });
    stage.addEventListener("pointerup", event => {
      if (event.pointerId !== pointer) return;
      const bounds = current(event);
      const resized = editing;
      reset();
      if (bounds.width > 0 && bounds.height > 0) commitBox(side, bounds, resized);
    });
    stage.addEventListener("lostpointercapture", reset);
    stage.addEventListener("pointercancel", reset);
  }

  function coordinates(side, region) {
    const details = el("details");
    details.append(el("summary", region ? "Edit region coordinates" : "Add region by coordinates"),
      el("p", "Use 0 to 1 across the displayed photo, measured from the upper left."));
    const form = el("form", undefined, "pl-coordinates");
    const inputs = {};
    for (const name of ["x", "y", "width", "height"]) {
      const label = el("label", name + " ");
      const input = el("input");
      Object.assign(input, {type: "number", min: "0", max: "1", step: "any", required: true,
        value: String(region?.bounds[name] ?? ({x: 0, y: 0, width: 0.25, height: 0.25})[name])});
      inputs[name] = input;
      label.append(input);
      form.append(label);
    }
    const save = el("button", region ? "Resize region" : "Add region");
    const error = el("output");
    form.addEventListener("submit", event => {
      event.preventDefault();
      const bounds = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.valueAsNumber]));
      try { commitBox(side, bounds, region?.id); }
      catch (problem) { error.textContent = problem.message; }
    });
    form.append(save, error);
    details.append(form);
    return details;
  }

  function photoPanel(side) {
    const panel = el("section", undefined, "pl-panel");
    panel.dataset.side = side;
    panel.append(el("h3", titles[side]));
    const view = layout.views[side];
    if (!view) {
      panel.append(el("p", side === "reverse" ? "Reverse unavailable. Front regions remain available." : "Choose the front photo to mark packages."));
      return panel;
    }
    const metadata = el("details");
    metadata.append(el("summary", "Photo details"), el("small", view.attachment_id + " · revision " + view.revision));
    if (view.regions.length) metadata.append(el("p", view.regions.map(region => regionName(side, region.id) + " · " + region.id).join(", ")));
    const toolbar = el("div", undefined, "pl-toolbar");
    toolbar.append(select("Zoom", [["1", "100%"], ["1.5", "150%"], ["2", "200%"]], String(zoom[side]), value => {
      zoom[side] = Number(value);
      render();
    }));
    const panButton = button(pan[side] ? "Draw mode" : "Pan mode", () => { pan[side] = !pan[side]; render(); });
    panButton.setAttribute("aria-pressed", String(pan[side]));
    toolbar.append(panButton);
    if (side === "reverse" && urls.front) {
      const control = button(guide ? "Hide front guide" : "Show front guide", () => { guide = !guide; render(); });
      control.setAttribute("aria-pressed", String(guide));
      toolbar.append(control);
    }
    panel.append(toolbar);
    const viewport = el("div", undefined, "pl-viewport");
    const stage = el("div", undefined, "pl-stage");
    stage.style.width = percent(zoom[side]);
    if (pan[side]) stage.classList.add("pl-pan");
    const image = shallowImage(side, titles[side]);
    image.className = "pl-original";
    stage.append(image);
    if (side === "reverse" && guide && urls.front) {
      const overlay = shallowImage("front", "");
      overlay.className = "pl-guide";
      stage.append(overlay);
    }
    for (const region of view.regions) {
      const owner = side === "front" ? layout.packages.find(pkg => pkg.frontId === region.id) : null;
      const box = el("span", owner ? packageName(owner.id) : regionName(side, region.id), "pl-box");
      positionBox(box, region.bounds);
      if (selected[side] === region.id) {
        box.classList.add("pl-selected");
        const handle = el("span", "", "pl-resize");
        handle.dataset.resize = region.id;
        handle.title = "Resize selected region";
        box.append(handle);
      }
      stage.append(box);
    }
    wireDrawing(stage, side);
    viewport.append(stage);
    panel.append(viewport);
    const region = view.regions.find(item => item.id === selected[side]);
    panel.append(select("Region", [["", "New region"], ...view.regions.map(item => [item.id, regionName(side, item.id)])],
      region?.id, id => { choose(side, id); render(); }));
    panel.append(coordinates(side, region));
    if (region) {
      const actions = el("div", undefined, "pl-toolbar");
      actions.append(button("Delete region", () => { layout.remove(side, region.id); choose(side, null); notify(); }));
      if (side === "reverse") {
        const opaque = button(region.visibility === "opaque" ? "Mark visible" : "Mark opaque", () => {
          layout.setOpaque(region.id, region.visibility !== "opaque");
          notify();
        });
        opaque.setAttribute("aria-pressed", String(region.visibility === "opaque"));
        actions.append(opaque);
      }
      panel.append(actions);
    }
    panel.append(metadata);
    return panel;
  }

  function crop(side, id) {
    const figure = el("figure");
    const region = layout.region(side, id);
    const {x,y,width,height} = region.bounds;
    const frame = el("div", undefined, "pl-crop");
    const image = shallowImage(side, regionName(side, id) + " crop");
    // Crop a browser-oriented image, preserving its native aspect ratio.
    image.style.width = percent(1 / width);
    image.style.transform = "translate(" + percent(-x) + ", " + percent(-y) + ")";
    const sizeFrame = () => { frame.style.aspectRatio = String(image.naturalWidth * width / (image.naturalHeight * height)); };
    image.addEventListener("load", sizeFrame);
    if (image.complete && image.naturalWidth) sizeFrame();
    frame.append(image);
    figure.append(frame, el("figcaption", regionName(side, id) + (region.visibility === "opaque" ? " · opaque" : "")));
    return figure;
  }

  function pairing() {
    const section = el("section", undefined, "pl-pairing");
    section.append(el("h3", "Package pairing"));
    if (!layout.packages.length) {
      section.append(el("p", "Draw a box around each physical package in Photo 1."));
      return section;
    }
    const pkg = layout.packages.find(item => item.id === activePackage) ?? layout.packages[0];
    activePackage = pkg.id;
    section.append(select("Package", layout.packages.map(item => [item.id, packageName(item.id) + " · " + (item.status === "confirmed" ? "paired" : item.status)]), pkg.id,
      id => { choose("front", layout.package(id).frontId); render(); }));
    const choices = layout.alternatives(pkg.id);
    const suggestion = layout.suggestions().get(pkg.id);
    const picked = previewReverse === null ? undefined : choices.some(item => item.id === previewReverse) ? previewReverse :
      pkg.reverseId ?? suggestion;
    const controls = el("div", undefined, "pl-toolbar");
    controls.append(select("Reverse region", [["", "Choose a region"], ...choices.map(item =>
      [item.id, regionName("reverse", item.id) + (item.id === suggestion ? " · nearby" : "")])], picked, id => {
        previewReverse = id || null;
        selected.reverse = id || null;
        render();
      }));
    const confirm = button("Match package", () => { layout.match(pkg.id, picked); previewReverse = undefined; notify(); });
    confirm.disabled = !picked || picked === pkg.reverseId;
    controls.append(confirm);
    for (const [label, status] of [["Unmatch", "unmatched"], ["Mark hidden", "hidden"]]) {
      controls.append(button(label, () => { layout.clearMatch(pkg.id, status); previewReverse = undefined; notify(); }));
    }
    const crops = el("div", undefined, "pl-crops");
    crops.append(crop("front", pkg.frontId));
    if (picked) crops.append(crop("reverse", picked));
    section.append(controls, crops, el("p", pkg.reverseId ? "Paired with " + regionName("reverse", pkg.reverseId) + ". Medicine identity still needs review." :
      pkg.status === "hidden" ? "Reverse hidden. No reverse crop attached." : "Unmatched. No reverse crop attached."));
    return section;
  }

  function render() {
    const panel = el("section", undefined, "package-layout");
    const photos = el("div", undefined, "pl-photos");
    photos.append(photoPanel("front"), photoPanel("reverse"));
    panel.append(el("h2", "Mark packages"), el("p", "Mark each package on the front photo. If you have a back photo, match the same package."), photos, pairing());
    container.replaceChildren(panel);
  }
  render();
  return {
    setPhoto(side, photo) {
      if (photo && !photo.url) throw new Error("A displayed photo URL is required.");
      layout.replaceView(side, photo);
      urls[side] = photo?.url;
      selected[side] = null;
      previewReverse = undefined;
      if (side === "front") activePackage = undefined;
      notify();
    },
    addProposals(side, response) {
      const ids = layout.addProposals(side, response);
      if (ids.length) notify();
      return ids;
    },
    snapshot: () => layout.snapshot(),
    dispose: () => container.replaceChildren(),
  };
}
