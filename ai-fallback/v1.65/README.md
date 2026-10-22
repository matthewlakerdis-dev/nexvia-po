# Nexvia Quote to PO v1.65 — AI fallback

This release preserves v1.64's supplier parsers and adds an optional **Read with AI** button. Normal Read/Compare never calls the AI service. AI reads create a preview only; the user must check the PDF, tick the review confirmation, and separately click Add/Apply.

## What to deploy

Run `backend/server.mjs` on a Node.js 22+ host with HTTPS in front of it. No npm dependencies are required. The service has one browser-facing endpoint: `POST /extract`. It calls OpenAI's Responses API with strict JSON schema, `store: false`, and no tools. Document instructions are treated as untrusted data.

The OpenAI key is never placed in the userscript. The browser sends a different proxy access token, kept in sessionStorage for the current tab. The endpoint is remembered in localStorage. Any script running on the same Nexvia origin can access that tab's token, so use a dedicated token for this service, rotate it if exposed, and keep provider spending limits in place.

## Hosting setup

1. Deploy the `backend` folder to your Node.js host, or build its Dockerfile. Use a single instance initially; hourly/concurrency limits are in memory and apply per instance.
2. Set these server-side environment variables in the host's secret/settings interface:
   - `OPENAI_API_KEY`: a dedicated OpenAI project API key. Do not send it in chat or put it in GitHub.
   - `AI_PROXY_TOKEN`: a new random token of at least 32 characters. Generate one locally with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"` and transfer it privately to the host and your browser settings.
   - `ALLOWED_ORIGINS`: your exact Nexvia origin, e.g. `https://company.nexvia.com` (no path or trailing slash). Multiple exact origins may be comma-separated.
   - `OPENAI_MODEL`: optional; defaults to `gpt-4.1-mini`. The selected model must support strict structured outputs.
   - `MAX_REQUESTS_PER_HOUR`: optional; defaults to 30 for this service instance. At most two upstream requests run concurrently.
   - `HOST`: use `0.0.0.0` when required by your hosting platform; the default is loopback for a reverse proxy.
   - `PORT`: use the port assigned by your hosting platform; defaults to 8787.
3. Start with `node server.mjs`. The `npm start` shortcut is intended for a local `.env` file copied from `.env.example`; hosted secret injection does not require an `.env` file.
4. Enable HTTPS through your host or reverse proxy. Forward `/extract` to the service. Permit at least 110 seconds for extraction requests and an 800 KB request body. Do not log request bodies, Authorization headers, or model output. The included server logs only startup status.
5. Put the host's HTTPS URL ending in `/extract` into **AI service settings** in the userscript. Enter `AI_PROXY_TOKEN` in **Service access token**, not the OpenAI API key.

## Using it

1. Install `nexvia-quote-to-po-v1.65.user.js` in place of the existing Nexvia script, then save and refresh Nexvia.
2. Choose one PDF. Try the normal Read/Compare first.
3. For an unfamiliar layout, open AI service settings, confirm sharing extracted text with your service and OpenAI, then click **Read with AI**. The PDF itself is not uploaded; browser-extracted/OCR text is sent. OCR assets may be downloaded by the existing PDF/OCR readers.
4. In invoice mode, choose **Add invoices**. AI cannot run Match PO or select deletions/replacements.
5. Review every description, quantity, unit price, GST setting and total against the PDF. AI can still make extraction mistakes even when arithmetic checks pass. Correct the preview if necessary, then tick the AI review confirmation. Editing a line or selection clears that confirmation.
6. Click Add/Apply as a separate action. Existing supplier-reference checks, duplicate detection, measure mapping and saved-PO verification still run.

## Limits and failure behaviour

- One PDF at a time; no simultaneous pasted text. Up to 20 MB, 40 extracted pages and 200,000 text characters. Oversized documents are rejected, never silently truncated.
- AUD invoices/quotes with positive quantities and 0% or 10% GST only. Credits, negative charges, uncertain taxes or unreconciled totals are rejected for manual review.
- Up to 200 extracted lines. Both server and browser validate finite values, cent-rounded arithmetic, item taxes, document totals, and source evidence. Evidence checks are not proof that the model identified the correct charge; human review remains required.
- Source layouts with unavoidable per-line GST rounding may be consolidated into one invoice charge with all original charge detail retained in its description, as with the standard parsers.
- On model refusal, incomplete response, timeout, bad JSON or failed validation, no AI preview is retained and no PO write is made.
- Exact CORS origin and bearer token are both required. Nexvia's Content Security Policy may block a custom backend URL even when CORS is configured. If so, an allowed same-origin HTTPS reverse proxy may be needed; this build does not weaken Nexvia's policy or request broad Tampermonkey cross-origin grants.

## Validation and current status

All 115 existing parser regression tests and 28 new AI/backend tests passed in the development workspace. New tests cover rejection of fabricated evidence, arithmetic/tax mismatches, non-AUD/ambiguous results, authentication/CORS checks, mocked provider refusal/failure, browser consent, append-only AI mode and actual Add/Apply review guards.

Backend HTTP handlers and provider calls were tested with in-process mocks because this workspace blocks listening on a TCP port. No live OpenAI request was made; no provider key is configured. The service is not deployed, and the live Nexvia workflow/CSP still needs verification after hosting setup.

The bundle includes `test/ai.test.mjs`; run `node --test --test-isolation=none test/ai.test.mjs` from the bundle root. Historical regression fixtures contain private invoice data and are intentionally not included in a public package.

API reference: https://developers.openai.com/api/docs/guides/structured-outputs
