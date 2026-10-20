# Activate the desktop dashboard and iPad report

The application is prepared. These steps require your GitHub and Microsoft 365
account access. No secret is required or should be sent in chat.

## 1. Enable the prepared website

1. Open https://github.com/matthewlakerdis-dev/nexvia-po/settings/pages
2. Under Build and deployment, select **Deploy from a branch**.
3. Select the prepared **gh-pages** branch and **/ (root)** folder.
4. Click Save and wait for GitHub to display the published site address.
5. Open that address. The expected address for this repository is:
   `https://matthewlakerdis-dev.github.io/nexvia-po/`

The agent can push website files but cannot change your repository's Pages
settings with its available access. The address above is a deployment target,
not a claim that Pages is already active. If GitHub shows a different address,
use that exact address in the following steps. The site has the app only; the
register is not committed to the public repository.

## 2. Register a Microsoft Entra application

1. Sign in at https://entra.microsoft.com/ with your organisation account.
2. Open **Identity > Applications > App registrations > New registration**.
3. Name: **Lennox Villa Scope Register**.
4. Supported accounts: **Accounts in this organizational directory only**.
5. Redirect URI platform: **Single-page application (SPA)**.
6. Redirect URI: paste the exact HTTPS site address from step 1, including its
   final slash. For the expected site above:
   `https://matthewlakerdis-dev.github.io/nexvia-po/`
7. Click Register.
8. Copy **Application (client) ID** and **Directory (tenant) ID** from Overview.
   These are public identifiers, not secrets.

If your account cannot register applications, your Microsoft 365 administrator
must complete this step. Do not create a client secret. Do not enable implicit
grant flows; this application uses MSAL's SPA authorization-code flow with PKCE.

## 3. Configure the file permissions

1. Within the app, open **API permissions > Add a permission**.
2. Choose **Microsoft Graph > Delegated permissions**.
3. Add **Files.Read** and **Files.ReadWrite**.
4. Save. If your tenant requires administrator approval, have the administrator
   review/grant consent for these delegated permissions.

The viewing page requests read access. The desktop requests read/write access
for the signed-in account's OneDrive. No app-only permissions or unattended
access are used. Broad OneDrive delegated permissions should be reviewed as part
of your normal app-consent process; the code operates on the named register file.

## 4. Connect and publish the first register

1. Open the website on your desktop (use the root URL, not index.html).
2. Click **Connection**.
3. Paste Application (client) ID and Directory (tenant) ID. Save connection.
4. Click **Sign in**, use the Microsoft 365 account that owns your register and
   complete the permission prompt.
5. Click **Import & backup tools > Load Excel register** and select the current
   populated Villa-Scope-Register.xlsx or .xlsm workbook.
6. Check the rows and links. The earlier uploaded blank workbook cannot supply
   your live records; use the current populated workbook on your computer.
7. Click **Save to OneDrive**. Wait for the saved confirmation.
8. Verify **Villa-Scope-Live-Register.json** exists in that account's OneDrive
   root, then refresh the desktop report and confirm its contents.

This private JSON file becomes the shared report source. Excel imports remain
available, but no automatic Excel watcher or Excel write-back is configured.
Keep a backup before replacing the shared register with another workbook.

## 5. Open the iPad report

1. On desktop, click **iPad report link**, then Copy report link.
2. Send/open that link using your preferred method. The agent has not sent it
   to anyone. The URL contains public app IDs and the report view only.
3. Open it in Safari on the iPad. Sign in with the SAME Microsoft 365 account.
4. Confirm the report loads without import or editing controls.
5. Tap a linked Villa, Scope and each PO document to check actual access.
6. Optionally use Safari **Share > Add to Home Screen**.
7. On desktop, edit one entry and Save to OneDrive. On iPad, tap Refresh report
   and check the change. It also checks every two minutes while in the foreground.

Other accounts would read their own OneDrive. Access to the owner's register
from different accounts is a separate shared-drive configuration, not part of
this version. Do not share your login with another user.

## Useful checks

- Redirect mismatch: the Entra SPA URI must exactly match the address shown in
  Connection, including path and final slash.
- Consent required: use Sign in again; obtain administrator consent if required.
- Report says not published: sign in with the same account used for desktop
  publishing and check the root JSON file exists.
- Save conflict: download a backup, refresh, reconcile, save again. Do not retry
  repeatedly against an unreviewed newer version.
- Missing PDF: supply its actual online link through Links on the desktop and
  Save to OneDrive. Check the viewer account's access to the document.
- Safari: allow Microsoft sign-in navigation and test first in a normal Safari
  tab before adding a Home Screen shortcut.

## Implementation references

Microsoft's browser download guidance requires the preauthenticated download URL
rather than an authenticated /content redirect. Uploads use Graph upload sessions
and do not send Graph bearer tokens to the upload/download URLs.

- https://learn.microsoft.com/graph/api/driveitem-get-content
- https://learn.microsoft.com/graph/api/driveitem-createuploadsession
- https://learn.microsoft.com/entra/identity-platform/quickstart-register-app

Live sign-in, tenant consent, OneDrive publication and physical iPad Safari
verification remain deployment checks after this account setup. Browser tests
with fictional fixtures cannot establish those live results.
