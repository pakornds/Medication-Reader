# Frontend API contract checks

Run `node frontend/tests/api/fixtures.mjs` from the repository root after installing the locked frontend dependencies. This type-checks the shared backend and package fixtures with TypeScript in strict mode. To refresh the wire types, activate the installed backend environment and run `python frontend/tests/api/generate_contracts.py`. The generator reads the mounted FastAPI schema and the Pydantic models used inside multipart and error handlers.

For the live check, install the bundled catalogue with `python tools/local_screening/install.py`. Start a dedicated FastAPI process with distinct synthetic demo nurse and pharmacist tokens configured via `MEDICATION_READER_DEMO_NURSE_TOKEN` and `MEDICATION_READER_DEMO_REVIEWER_TOKEN`. In a shell with the same tokens, set `TEST_API_URL` to the local server and run `node frontend/tests/api/live.mjs` with Node 24. The check creates a transient synthetic encounter.

Consumers can create a client with `createClient(baseUrl, token)` from `src/api/client.ts`. Reuse the original command, revision and request ID for an exact retry. HTTP failures throw `ApiError` with the status and any structured service error in `service`. An interrupted fetch rejects with the original network or abort error. The existing intake can use `client.intakeProducts` for choices with separate source fields.
