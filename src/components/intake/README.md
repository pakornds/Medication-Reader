# Staff intake component

Mount once per authorized encounter. The host supplies the assigned role, UI language, product lookup and review callback. The component keeps its transient draft and original Files in memory. The server remains responsible for authorization. The standalone component can be exercised at `/tests/ui/intake/preview.html` on a repository-root Vite server.

```ts
const intake = mountIntake(inputPanel, {
  caseId, role, collector, language, searchProducts, onSubmit,
  packages: () => editor.snapshot().packages.map(p => ({id: p.id, label: p.id})),
})
const editor = mountPackageLayout(layoutPanel, {
  caseId, onChange: scene => intake.syncLayout(scene),
})
intake.attachLayout(editor)
```

Return each lookup result as `{id, name, label?, strength?, form?, tpu?, release?}`. Preserve structured fields available from the catalogue. Manual selection creates one editable, unverified row. A later selected scan can be offered through `intake.offerScan(link)`. The user confirms an existing row, retaining its entered fields. A link includes case, source, attachment, revision, side, region and package identifiers.

`onSubmit` receives a draft envelope with one File per current attachment, source metadata, editable manual rows, reported use, schedule uncertainty, written records and the separate question. Supply current front/reverse originals to the capture endpoint and combine the editor's geometry with the encounter's clinical evidence. Targeted retakes arrive as additional attachments with package ID and intended view; both original table views stay available. Use the encounter's current admission revision and request ID when saving. Superseded files and links, when referenced by a manual row, are separate from the active upload list. A rejected submit leaves inputs and IDs available for retry.

On encounter exit, call `intake.dispose()` and `editor.dispose()`. The intake component releases object URLs it created. For the browser check, install the frontend dependencies and start Vite at the repository root with `frontend/node_modules/.bin/vite --config tests/ui/intake/vite.config.mjs --port 5180`. With Playwright on NODE_PATH, run `node tests/ui/intake/browser.cjs`. To exercise the actual capture API, set INTAKE_API_ORIGIN on both processes, start the local backend with a synthetic nurse token, and set INTAKE_TEST_TOKEN on the browser run.
