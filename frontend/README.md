# MedRec TH

Use Node.js 22.13 or later in the 22.x series, or Node.js 24. Start FastAPI with the [repository setup](../README.md#run-locally). The [synthetic demo](../docs/demo/README.md) explains how to configure photo and text analysis.

Run from `frontend/`.

```sh
npm ci
npm run lint
npm run build
npm run dev
```

The development server proxies requests to FastAPI at `http://127.0.0.1:8000`. Set `MEDREC_API_TARGET` when using a different development backend.

| Page | What staff can do |
| --- | --- |
| Input | Upload labels, paste a written list or open **Enter medicine manually**. The manual form fills strength and form from the selected product. **Fill fields from wording** fills the editable dose and schedule fields. All three paths feed the same list. |
| Review | Edit the same rows, check interactions and duplicate ingredients, and select the rows for handoff. A row with a readable name can proceed without a TMT code. |
| Output | Copy a tab-separated list or download structured JSON for entry in the hospital system. |

History shows successful analysis times and lets you open completed handoff lists on this device. It keeps medication names, presentation, dose, schedule and quantity. Original photos, pasted text and facility contacts remain in tab memory. The list, pasted text and photos live in tab memory. Use the handoff before closing or refreshing the tab. The analysis and screening services process the submitted evidence and product IDs without creating encounters or hospital records.

With both servers running and the bundled TMT and FEST data installed, test the default workflow from the repository root. The test replays analysis fixtures and calls the real local catalogue and DDI endpoints.

```sh
npm --prefix frontend install --no-save --package-lock=false playwright
npm --prefix frontend exec -- playwright install chromium
TEST_UI_URL=http://127.0.0.1:5173 node frontend/tests/workflow/medication-list.cjs
```

Set `CHROME_PATH` to use an existing Chromium executable.

The staff reconciliation fixture is available with `VITE_MEDREC_STAFF_WORKSPACE=true`. Its [admission contract](../docs/specs/reconciliation-contract.md#admission-encounters) covers synthetic tokens, encounters and mock-hospital tests. Its development page fixtures and `frontend/tests/workflow/connected.cjs` use the staff workspace.
