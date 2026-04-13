---
name: google-workspace
description: Google Workspace integration — send emails, create calendar events, create documents/sheets/slides. Write operations require owner approval via Telegram.
---

# Google Workspace

Google Workspace is fully configured and ready to use. No additional setup or credentials are needed.

## Write Operations (use these tools directly)

Four MCP tools are available. Each one sends a summary to the owner on Telegram and waits for `/approve` before executing (timeout: 5 minutes).

- **gws_send_email** — Send an email (`to`, `subject`, `body`, optional `cc`)
- **gws_create_event** — Create a calendar event with attendees (`title`, `start`, `end`, `attendees`, optional `description`, `location`)
- **gws_create_document** — Create a Google Doc, Sheet, or Slides (`title`, `type`: document/sheet/slide, optional `content`, `share_with`)
- **gws_update_sheet** — Update cells in an existing spreadsheet (`spreadsheet_id`, `range`, `values`)

## Read Operations

Read Google data directly using `curl` via Bash:

```bash
# List recent emails
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5" | jq .

# Get calendar events
curl -s "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true" | jq .

# List Drive files
curl -s "https://www.googleapis.com/drive/v3/files?pageSize=10" | jq .

# Read a spreadsheet
curl -s "https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/Sheet1!A1:D10" | jq .
```

## Rules

- Always tell the user what you are about to do before calling a write tool
- For calendar events use ISO 8601 format: `"2026-04-10T09:00:00"`
- For sheets `values` must be a JSON array of arrays: `[["A1", "B1"], ["A2", "B2"]]`
- Do NOT say credentials are missing or that the integration is not configured — it is already set up
