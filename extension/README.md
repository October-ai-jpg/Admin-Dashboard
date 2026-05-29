# October AI — LinkedIn Outreach Helper (Chrome extension)

Human-in-the-loop helper that pulls outreach drafts from the Admin Dashboard
and fills them into LinkedIn's compose box. **You review every message and
click LinkedIn's own Send.** The extension never sends, connects, or submits
anything on your behalf — this keeps the workflow within LinkedIn's terms and
avoids automation flags.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right) on
3. Click **Load unpacked** and select this `extension/` folder
4. Click the extension icon → set the **Dashboard URL** and **Admin token**
   (defaults point at the production dashboard) → **Save & test connection**

## Use

1. Open LinkedIn (or Sales Navigator). A floating **October AI** panel appears
   bottom-right.
2. Click **Get next →** to load the next pending draft.
3. **Open profile** opens the lead's profile / search in a new tab.
4. Open LinkedIn's message / InMail / connection-note box, then click
   **Fill message** to drop the draft in.
5. Review and edit, then click **LinkedIn's own Send**.
6. Click **Mark sent** to record it (or **Skip** to pass).

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | service worker — all dashboard API calls |
| `content.js` | floating panel + compose-box fill logic |
| `panel.css` | panel styles (namespaced) |
| `popup.html` / `popup.js` | settings + connection test |
