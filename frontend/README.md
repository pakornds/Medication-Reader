# MedRec TH frontend

Use Node.js 22.13 or later in the 22.x series, or Node.js 24. Run these commands from `frontend/`.

```sh
npm ci
npm run lint
npm run build
npm run dev
```

The build type-checks the app and writes the production bundle to `frontend/dist/`. Open `/new-patient/input` to enter medicines, attach photos and record notes, then open Review to inspect the draft. The development server proxies catalogue search and medication analysis to FastAPI at `http://127.0.0.1:8000`.

Run the browser checks at `/tests/navigation.html` and `/tests/intake.html` on the development server. Each displays **PASS** on success. Home, Output and History are placeholders. The open draft is held in memory.
