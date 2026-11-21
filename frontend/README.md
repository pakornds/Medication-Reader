# MedRec TH staff workspace

Use Node.js 22.13 or later in the 22.x series, or Node.js 24. Start FastAPI from the repo root with the [backend setup](../AGENTS.md#commands). Configure distinct synthetic staff tokens before starting FastAPI. The sign-in and role settings are documented under [admission encounters](../docs/specs/reconciliation-contract.md#admission-encounters).

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

| Page | Staff workflow |
| --- | --- |
| Home | Sign in to reopen an assigned encounter or start a case. |
| Input | Select a local catalogue product or enter an evidenced name. Enter the dose, unit, schedule and quantity separately. Upload one label-side photo of all the packages and choose **Analyze evidence**. OpenAI locates the packages and reads each crop. Review the resulting rows and optionally adjust boxes, transcribe unreadable labels or match a reverse view. |
| Review | Compare each draft row with its sources, save it to the encounter, document the interview, and verify current use. Refer an unidentified item for pharmacist review. Assigned doctors and pharmacists can run the optional checks and inspect coverage. |
| Output | Inspect eligible and excluded medicines. An assigned pharmacist approves and imports a selection in one action. |
| History | See successful import timestamps in this browser. Sign in to reopen receipts available to the staff account. |

Staff tokens and the open draft live in page memory. The synthetic FastAPI service holds encounters, original photos and mock hospital records in server memory. Use synthetic documents. A server restart clears those records. Browser history contains successful timestamps only.

The development fixtures at `/tests/home.html`, `/tests/navigation.html` and `/tests/intake.html` report their own results. To test the staff handoff against a running synthetic backend with the local TMT catalogue installed, make Playwright and Chromium available and run from the repo root:

```sh
TEST_UI_URL=http://127.0.0.1:5173 TEST_API_URL=http://127.0.0.1:8000 \
  node frontend/tests/workflow/connected.cjs
```

Export the same synthetic nurse and pharmacist token variables in the test shell. Set `CHROME_PATH` to use an existing Chromium executable.
