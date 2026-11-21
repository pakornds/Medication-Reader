# MedRec TH

Use Node.js 22.13 or later in the 22.x series, or Node.js 24. Start FastAPI from the repo root with the [backend setup](../AGENTS.md#commands).

For photo analysis, keep `OPENAI_API_KEY` and `OPENAI_MODEL` in the repository-root `.env` on the server. With uv, load that file explicitly from the repo root:

```sh
uv run --project backend --env-file .env uvicorn app.main:app --reload --reload-dir backend/app
```

Run from `frontend/`:

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
| Review | Edit the same rows, check interactions and duplicate ingredients, and select the rows for handoff. |
| Output | Copy a tab-separated list or download structured JSON for entry in the hospital system. |

History shows only the times of successful analyses on this device. The list, pasted text and photos live in tab memory. Use the handoff before closing or refreshing the tab. The analysis and screening services process the submitted evidence and product IDs without creating encounters or hospital records.

Run the browser workflow with Playwright, Chromium and a running backend with the local TMT catalogue:

```sh
TEST_UI_URL=http://127.0.0.1:5173 node frontend/tests/workflow/medication-list.cjs
```

Set `CHROME_PATH` to use an existing Chromium executable.

The staff reconciliation fixture is available with `VITE_MEDREC_STAFF_WORKSPACE=true`. Its [admission contract](../docs/specs/reconciliation-contract.md#admission-encounters) covers synthetic tokens, encounters and mock-hospital tests. Its development page fixtures and `frontend/tests/workflow/connected.cjs` use the staff workspace.
