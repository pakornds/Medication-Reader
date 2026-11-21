// Intake geometry only. Row evidence, clinical verification and import stay with their owners.
const sides = ["front", "reverse"];

function checkedBounds({x, y, width, height}) {
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
      width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error("Choose a region inside the photo.");
  }
  return {x, y, width, height};
}

export function displayPoint(rect, clientX, clientY) {
  const clamp = value => Math.max(0, Math.min(1, value));
  return {x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height)};
}

export function boundsBetween(a, b) {
  return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)};
}

function distance(a, b) {
  return Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
}

export class PackageLayout {
  constructor(caseId) {
    if (!caseId?.trim()) throw new Error("Choose an encounter.");
    this.caseId = caseId;
    this.views = {front: null, reverse: null};
    this.revisions = {front: 0, reverse: 0};
    this.usedAttachments = new Set();
    this.packages = [];
    this.sequence = 0;
  }

  replaceView(side, photo) {
    if (!sides.includes(side)) throw new Error("Unknown photo side.");
    if (photo && (!photo.attachment_id?.trim() || this.usedAttachments.has(photo.attachment_id) ||
        !Number.isInteger(photo.exif_orientation ?? 1) || (photo.exif_orientation ?? 1) < 1 ||
        (photo.exif_orientation ?? 1) > 8)) throw new Error("Choose a fresh attachment and valid orientation.");
    if (photo?.revision !== undefined && (!Number.isSafeInteger(photo.revision) || photo.revision <= this.revisions[side])) throw new Error("Choose a newer photo revision.");
    if (photo) this.revisions[side] = photo.revision ?? this.revisions[side] + 1;
    if (photo) this.usedAttachments.add(photo.attachment_id);
    this.views[side] = photo ? {
      attachment_id: photo.attachment_id, revision: this.revisions[side],
      exif_orientation: photo.exif_orientation ?? 1, coordinate_space: "exif_transposed_display", regions: [],
    } : null;
    if (side === "front") this.packages = [];
    else for (const pkg of this.packages) this.clearMatch(pkg.id);
  }

  add(side, bounds) {
    const view = this.views[side];
    if (!view) throw new Error("Choose a photo first.");
    const region = {bounds: checkedBounds(bounds), id: side + "-" + ++this.sequence, visibility: "visible"};
    view.regions.push(region);
    if (side === "front") this.packages.push({
      id: "package-" + this.sequence, frontId: region.id, reverseId: null, status: "unmatched",
    });
    return region.id;
  }

  // Detector responses must carry the original attachment ID and revision.
  addProposals(side, {attachment_id, revision, bounds}) {
    const view = this.views[side];
    if (!view || view.attachment_id !== attachment_id || view.revision !== revision) return [];
    return bounds.map(checkedBounds).map(box => this.add(side, box));
  }

  region(side, id) {
    const region = this.views[side]?.regions.find(item => item.id === id);
    if (!region) throw new Error("Choose a current region.");
    return region;
  }

  package(id) {
    const pkg = this.packages.find(item => item.id === id);
    if (!pkg) throw new Error("Choose a current package.");
    return pkg;
  }

  clearMatch(packageId, status = "unmatched") {
    if (!["unmatched", "hidden"].includes(status)) throw new Error("Unknown match status.");
    Object.assign(this.package(packageId), {reverseId: null, status});
  }

  match(packageId, reverseId) {
    this.region("reverse", reverseId);
    const pkg = this.package(packageId);
    if (this.packages.some(item => item !== pkg && item.reverseId === reverseId)) {
      throw new Error("Unmatch the other package before assigning this region.");
    }
    Object.assign(pkg, {reverseId, status: "confirmed"});
  }

  bumpRevision(side) {
    this.views[side].revision = ++this.revisions[side];
  }

  setOpaque(id, opaque) {
    const region = this.region("reverse", id);
    const visibility = opaque ? "opaque" : "visible";
    if (region.visibility === visibility) return;
    region.visibility = visibility;
    this.bumpRevision("reverse");
  }

  edit(side, id, bounds) {
    const region = this.region(side, id);
    const next = checkedBounds(bounds);
    if (Object.keys(next).every(key => region.bounds[key] === next[key])) return;
    region.bounds = next;
    this.bumpRevision(side);
    const owner = this.packages.find(pkg => (side === "front" ? pkg.frontId : pkg.reverseId) === id);
    if (owner) this.clearMatch(owner.id);
  }

  remove(side, id) {
    const region = this.region(side, id);
    const view = this.views[side];
    view.regions.splice(view.regions.indexOf(region), 1);
    this.bumpRevision(side);
    if (side === "front") this.packages = this.packages.filter(pkg => pkg.frontId !== id);
    else for (const pkg of this.packages) if (pkg.reverseId === id) this.clearMatch(pkg.id);
  }

  alternatives(packageId) {
    const pkg = this.package(packageId);
    const front = this.region("front", pkg.frontId);
    return (this.views.reverse?.regions ?? []).filter(region =>
      !this.packages.some(other => other !== pkg && other.reverseId === region.id)
    ).map(region => ({id: region.id, distance: distance(front.bounds, region.bounds)}))
      .sort((a, b) => a.distance - b.distance);
  }

  suggestions() {
    const choices = this.packages.filter(pkg => pkg.status === "unmatched").flatMap(pkg =>
      this.alternatives(pkg.id).map(option => ({...option, packageId: pkg.id})));
    const suggested = new Map();
    const taken = new Set();
    for (const choice of choices.sort((a, b) => a.distance - b.distance)) {
      if (choice.distance <= .35 && !taken.has(choice.id) && !suggested.has(choice.packageId)) {
        suggested.set(choice.packageId, choice.id);
        taken.add(choice.id);
      }
    }
    return suggested;
  }

  link(side, id) {
    this.region(side, id);
    const {attachment_id, revision} = this.views[side];
    return {case_id: this.caseId, side, attachment_id, revision, region_id: id};
  }

  snapshot() {
    return structuredClone({
      version: "1", case_id: this.caseId, ...this.views,
      packages: this.packages.map(pkg => ({id: pkg.id, front_regions: [this.link("front", pkg.frontId)], items: []})),
      reverse_matches: this.packages.filter(pkg => pkg.reverseId).map(pkg =>
        ({package_id: pkg.id, region: this.link("reverse", pkg.reverseId), status: "confirmed"})),
      sources: [],
    });
  }
}
