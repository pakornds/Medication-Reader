# Package layout editor

Load `editor.css`, then mount the editor once per open encounter. Supply the two original image URLs from the intake component. The editor draws and crops from those same URLs in memory. For local files, the caller creates and revokes the object URLs.

```js
import {mountPackageLayout} from "./editor.mjs";

const editor = mountPackageLayout(container, {
  caseId,
  onChange(layout, {hiddenPackageIds}) {
    // Send the geometry through the caller's encounter-saving path.
    // Keep clinical rows and their evidence in the encounter owner.
  },
});
editor.setPhoto("front", {attachment_id: front.id, revision: front.revision,
  url: front.url, exif_orientation: front.orientation});
editor.setPhoto("reverse", {attachment_id: reverse.id, revision: reverse.revision,
  url: reverse.url, exif_orientation: reverse.orientation});
```

Photo 1 works alone. `setPhoto(side, null)` removes a view. Pass a fresh attachment ID when replacing a photo. If a revision is supplied, it must be newer than the last revision on that side. The caller supplies the original file's EXIF orientation (1 when absent). The browser applies it once. Bounds refer to the displayed, oriented image with origin at top left. `addProposals(side, {attachment_id, revision, bounds})` takes an array of normalized rectangles. On detector failure, staff continue manually. Suggestions do not enter the confirmed matches.

`snapshot()` returns intake geometry conforming to the package capture contract once the front image exists. Before the first front capture or after its removal, `front` is null and the host should wait before saving. Each physical package created in the editor has one initial front region. The clinical owner associates additional orders, appearances and evidence with the stable package ID. Hidden package IDs are transient pairing observations in the second callback argument. An opaque reverse may be attributed to the package but cannot supply appearance evidence.

Adding regions preserves the current revision. Editing or deleting a region, or changing its visibility, advances that side's revision and reissues its current region links. A resized matched region requires a new staff match. Replacing Photo 2 clears reverse matches and preserves front package IDs. Replacing Photo 1 withdraws prior front ownership; new marks get fresh IDs. The caller retains prior medicine rows, history and unresolved items on retake (#86) and reconciles this geometry with the clinical draft (#16). Never replace a populated clinical capture wholesale with this geometry-only snapshot. The row-level helpers in `src/lib/evidence-pairing/` operate after intake has associated a case evidence item with a row. Linking two physical views here creates no row evidence or current-use decision.

From the repository root, run `node --test tests/ui/package-layout/layout.test.mjs`. Serve the repository root over local HTTP and open `/tests/ui/package-layout/preview.html` for the synthetic component demo. Its two-photo fixture swaps A and B and includes an overlapping opaque box. The browser test uses Playwright on `NODE_PATH` and `PACKAGE_LAYOUT_URL` for the server origin (default http://127.0.0.1:18484). Run `node tests/ui/package-layout/browser.cjs` to exercise real drags, correction, zoom, native touch and an EXIF-rotated JPEG. Call `dispose()` when leaving the encounter.
