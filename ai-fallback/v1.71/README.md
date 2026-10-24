# v1.71 — Confirm and learn layout

After a successful **Read with AI**, check every line against the PDF, correct the preview if needed, tick the review checkbox, enter a supplier/layout name and click **Confirm and learn layout**. This saves a declarative parsing template on your NAS. It does not rewrite the userscript or create executable parsing code.

Future normal Read/Compare operations can try the saved template first. New descriptions, quantities, rates and amounts are read from the new PDF. Supplier ABN, headings, column positions, printed unit, arithmetic and printed net/GST/gross totals must match the learned rules. Scans still need OCR; matched templates do not call OpenAI.

If a known supplier's saved layouts fail validation, the read stops and asks for AI review. Network/service failures can fall back to the existing standard parsers. AI is never called automatically. Existing PO review, measure mapping, reference/duplicate checks and final saved-line verification remain in place.

## Update your existing Synology installation

The `nas/server.mjs` download is self-contained and uses only Node.js built-ins. You do not need to replace several dependent modules.

1. Back up your existing `/docker/nexvia-ai/backend/server.mjs`.
2. Download `ai-fallback/v1.71/nas/server.mjs` and replace `/docker/nexvia-ai/backend/server.mjs` with that downloaded code file. It must be named exactly `server.mjs`, not `server.mjs.txt`. Do not copy this README into it. Older `validation.mjs` can remain; the self-contained service does not import it.
3. Create `/docker/nexvia-ai/data/` in File Station. Allow the container user to read and write this folder. Protect it from other users; do not commit it to GitHub.
4. In your existing project-root `.env`, append:

   ```dotenv
   TEMPLATE_STORE_PATH=/data/layouts.json
   ```

   Keep the existing OpenAI key, proxy token, allowed origin and model settings.
5. Add the following volume to the existing service in Container Manager's project YAML:

   ```yaml
   volumes:
     - ./backend:/app:ro
     - ./data:/data
   ```

   See `nas/compose.yaml` for the full configuration matching the existing Node-container setup.
6. Recreate/rebuild the project so the new volume and environment variable are applied. A simple restart does not add a new mount or environment variable. The log should show `AI extraction proxy ready`.
7. Install `downloads/nexvia-quote-to-po-v1.71.user.js`, save and refresh Nexvia. Keep the same service URL and proxy token. No certificate, router or reverse-proxy change is needed: `/templates` uses the same HTTPS service as `/extract`.

If you use a custom Docker image rather than the existing bind-mounted backend, rebuild that image. The modular `backend/` sources and Dockerfile are provided as an alternative; deploy all four `.mjs` modules together for that option.

## Learn and reuse

1. Select one PDF and click **Read with AI**.
2. Review descriptions, product codes, quantities, rates, units and taxes. OCR can still misread product codes; financial reconciliation is not proof of correct text.
3. Tick **I checked the AI...**, enter a layout name such as `Supplier quote`, and click **Confirm and learn layout**. This saves rules only; it does not add PO lines. Learning itself makes no OpenAI call.
4. On successful learning, **Try saved NAS layouts automatically** is enabled in this browser. That option sends extracted text and its positions to your NAS during normal reads, without sending it to OpenAI. Other devices must enter the same service credentials and enable this option.
5. For the next matching document use the normal **Read quote/Compare with PO** button. The log identifies a saved-layout read and states that no AI request was made. Review the preview before importing.
6. Open **AI service settings → Saved layouts** to view rules or delete a layout. Deleted layouts stop matching on the next read. Template lookup is not cached across reads.

## First-release scope

Learning is deliberately limited to clear, one-page tables with:

- One unique printed supplier ABN.
- Clear quantity, description, price and extended-amount headings.
- A printed unit on each row; a consistent unit and tax treatment across the training table.
- Unambiguous numeric columns and printed subtotal, GST and total.
- AUD context, positive quantities, nonnegative rates/amounts, and 0% or 10% GST.

It supports new quantities/prices and additional rows in the same table layout. Some changes in header height can be accepted; changed column locations or printed units are rejected. Discounts that break quantity-times-price equality are rejected.

Mixed-tax/mixed-unit tables, multi-page invoices, bundles, consolidated summaries, unprinted units and ambiguous layouts cannot be learned reliably by this initial version. In those cases the script explains why no template was saved and you can keep using AI. It does not save fixed amounts or silently guess a general rule.

## Persistence and privacy

Templates are stored atomically in the configured JSON file, with a maximum of 100 layouts. They contain a user-supplied name, ABN, headings, column coordinates, printed-unit rule and tax/price basis. They contain no example invoice amounts, quantities, descriptions or full source documents. Keep the data volume mounted across container replacements and back it up with your NAS data.

All layout API actions require the same exact origin and proxy token as AI extraction. They do not use the OpenAI provider or consume its hourly request allowance. Concurrent writes are serialised. Malformed storage is rejected rather than silently overwritten. Ambiguous multiple matching layouts require review/removal.

Data is scoped to this backend instance, not separate users; share its proxy token only with users who may view, save and delete the same supplier layouts.

## Verification

Existing parser, OCR, settings, AI validation and supplier regressions passed alongside new learning, persistence and browser-flow tests. Tests include training on one document and reading another with new amounts, multiple rows, changed units, supplier/header mismatches, duplicate templates, disk persistence, failed checks and zero provider calls on learned reads.

These are local/in-process tests with mocked provider and network calls. Learning was additionally exercised on locally OCR-extracted geometry from the uploaded insulation scan. Live browser OCR can differ. No live NAS or OpenAI account was accessed, and live Nexvia verification is still needed.

The public `test/` files use synthetic documents. Private uploaded PDFs and historical customer fixtures are not included.
