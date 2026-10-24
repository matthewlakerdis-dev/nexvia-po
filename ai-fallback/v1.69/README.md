# v1.69 — OCR evidence matching and AI rejection diagnostics

This release fixes evidence matching when browser OCR puts vertical-bar separators between words or separates a dollar sign from its amount. Browser and server apply the same normalization while retaining quantity, price, GST, subtotal, total and source checks. The extraction prompt recognises Australian ABN/address/GST currency context; dollar signs alone are not treated as proof of USD.

The browser now displays the backend's bounded error message. The backend reports a specific static validation reason, and distinguishes incomplete output, refusal, ambiguous output and invalid JSON. It does not return provider response bodies, document/model output or credentials in errors.

## Existing Synology installation

1. Replace the existing userscript with `downloads/nexvia-quote-to-po-v1.69.user.js` and refresh Nexvia.
2. Replace **both** `/docker/nexvia-ai/backend/server.mjs` and `/docker/nexvia-ai/backend/validation.mjs` with this release's versions from `ai-fallback/v1.69/backend/`.
3. Restart the Nexvia AI container so Node loads the replaced files. If your container uses a built image instead of the bind-mounted folder, rebuild the image.
4. Keep `.env`, the OpenAI key, proxy token, allowed origin, HTTPS certificate and reverse proxy unchanged.
5. Read the scan with AI again. Review quantities, prices, product codes and taxes against the PDF before adding anything. OCR can still misread product codes.

Original hosting instructions: https://github.com/matthewlakerdis-dev/nexvia-po/tree/main/ai-fallback/v1.65

## Verification

The evidence mismatch was reproduced using local Tesseract OCR of the user-supplied scan and a mathematically correct sample extraction. The original AI response from the NAS is not available; no live OpenAI call was made. This is a demonstrated validation bug, not proof that it was the sole cause of that request's HTTP 422. If the retry is rejected, the new message identifies the failed validation category.

No invoice files, OCR text, credentials or customer details are included in this public release.
