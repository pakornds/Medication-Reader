# MedRec TH frontend

Use Node.js 22.13 or later in the 22.x series, or Node.js 24. Run these commands from `frontend/`.

```sh
npm ci
npm run lint
npm run build
npm run dev
```

The build type-checks the app and writes the production bundle to `frontend/dist/`. Open the local URL printed by Vite to see the starter. To exercise navigation, open `/tests/navigation.html` on the development server and wait for **PASS**.

The starter provides English and Thai navigation, light and dark themes, and placeholder routes for Home, New patient (Input, Review, Output), and History. It stores the chosen theme and language in the browser. The clinical workflow and API client are tracked separately.
