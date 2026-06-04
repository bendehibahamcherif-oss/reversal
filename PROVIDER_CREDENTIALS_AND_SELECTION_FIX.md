# Provider Credentials and Selection Fix

## 1. Root cause

The production bug was caused by duplicate provider state paths returning incompatible shapes and deriving provider runtime from different credential sources:

- `/api/providers/health` was mounted through `marketStreamRoutes` before the provider credential routes and returned MarketStream adapter health as `providers`, while canonical feed/provider data was placed in a separate `canonicalProviders` field.
- Credential persistence existed in `credentialStore`, but credential health did not consistently resolve backend-saved credentials, environment credentials, active provider selection, and feed status through one canonical flow.
- Active provider persistence used a resolver that preferred a hard-coded provider order and could fall back to `fallback_demo`, causing the saved user selection and backend runtime selection to diverge.
- Credential list routes returned arrays and masked metadata mixed with legacy fields instead of the required provider-keyed masked status object.

## 2. Duplicate states found

The duplicated state paths were:

- `server/api/marketStreamRoutes.js` for `/api/providers/health`.
- `server/api/providerCredentialRoutes.js` for `/api/providers/*` credentials and active-provider routes.
- `server/api/feedRoutes.js` for `/api/feed/status` and `/api/feed/providers/active`.
- `server/feeds/feedManager.js` active provider resolution and provider status normalization.
- `server/feeds/providers/credentialStore.js` backend-saved credential metadata only, without environment fallback in the same metadata path.

## 3. Backend files changed

- `server/feeds/providers/credentialStore.js`
- `server/feeds/feedManager.js`
- `server/api/providerCredentialRoutes.js`
- `server/api/marketStreamRoutes.js`
- `server/api/feedRoutes.js`
- `server/tests/providerState.test.js`
- `package.json`

## 4. Frontend files changed

No frontend files were changed because the `intraday-reversal-engine` repository is not present under `/workspace` in this environment. The backend now returns the canonical contracts the frontend flow requires, and frontend validation commands could not be run for the same reason.

## 5. Endpoint contracts fixed

Fixed backend contracts:

- `GET /api/providers/credentials` now returns provider-keyed masked credential status only.
- `POST /api/providers/credentials/:providerId` stores backend credentials and returns canonical provider state plus masked credential status.
- `DELETE /api/providers/credentials/:providerId` deletes backend credentials, recomputes health, and removes invalid active credential providers when needed.
- `GET /api/providers/health` now returns canonical provider objects directly in `providers`, with `activeProviders`, `providerOrder`, `source`, and `warnings`.
- `POST /api/providers/active` validates, deduplicates, preserves order, rejects unknown providers, rejects credential providers without credentials, and persists the backend source of truth.
- `GET /api/feed/status` now returns active provider and provider order data consistent with `/api/providers/health`.

## 6. Credentials persistence fix

Credential resolution now follows one priority order, and saving a now-valid credentialed provider promotes that provider into the persisted active-provider set so the returned provider state is immediately selectable/active instead of remaining stuck behind stale `missing_credentials` health:

1. backend-saved credential
2. environment variable
3. none/missing

The credentials endpoint never returns a full API key. Alpha Vantage recognizes backend-saved credentials and environment variables such as `ALPHA_VANTAGE_API_KEY`, `ALPHAVANTAGE_API_KEY`, and `ALPHA_VANTAGE_KEY`.

## 7. Active provider persistence fix

Provider selection saves through `feedManager.saveActiveProviders()`, which validates the submitted arrays, deduplicates provider IDs, preserves requested order, updates `enabledByProvider`, persists the selected provider list, and rebuilds canonical provider status from the same backend state.

## 8. fallback_demo behavior fix

`fallback_demo` is no longer silently re-added after a user saves at least one viable provider. Saving `['yahoo']` persists exactly `['yahoo']`; saving `['yahoo', 'alphaVantage']` persists exactly that order when Alpha Vantage has credentials. Emergency fallback is only used by the resolver when there are no viable providers in non-strict internal flows, with an explicit warning available from the resolver path.

## 9. Tests added

Added `server/tests/providerState.test.js`, covering:

- Alpha Vantage credential save returns configured.
- Credential listing masks and never echoes the full key.
- Provider health reports Alpha Vantage configured after save.
- Configured Alpha Vantage never returns `missing_credentials` runtime status or “not configured” warning.
- Deleting Alpha Vantage credentials changes credential status to missing.
- Saving Yahoo only persists `['yahoo']` without fallback re-add.
- Saving Yahoo plus Alpha Vantage persists both in order.
- Feed status active providers/order match provider health.
- Selecting Alpha Vantage without credentials returns `400`.
- Environment Alpha Vantage key counts as configured.
- Unknown provider is rejected.

## 10. Validation results

- `npm test`: passed.
- `npm run build`: passed.
- `npm run server:smoke`: started successfully and many endpoints passed, but was manually terminated after repeated Yahoo network fetch failures caused the smoke suite to run for several minutes in this environment.
- `npm run lint`: unavailable; no `lint` script exists in this backend package.
- `npm run typecheck`: unavailable; no `typecheck` script exists in this backend package.
- `npm run frontend:build`: unavailable; no `frontend:build` script exists in this backend package and the frontend repository is absent.

## 11. Remaining risks

- Frontend code could not be patched or tested because `intraday-reversal-engine` is not present in this workspace.
- `server:smoke` depends on live Yahoo requests and can be very slow or hang-like when external fetches fail repeatedly.
- Legacy `/api/feed/providers/:provider/credentials` routes still exist for compatibility, but the canonical production contract is now under `/api/providers/*`.
