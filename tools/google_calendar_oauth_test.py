# =============================================================================
# google_calendar_oauth_test.py
# =============================================================================
#
# PREREQUISITES
# =============================================================================
#
# 1. Install dependencies:
#    pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client
#
# 2. Google Cloud Console setup:
#    a) Go to https://console.cloud.google.com/
#    b) Create a project (or use an existing one)
#    c) Enable the Google Calendar API:
#       APIs & Services → Library → search "Google Calendar API" → Enable
#    d) Configure OAuth Consent Screen:
#       APIs & Services → OAuth consent screen
#       - User Type: External (for personal accounts) or Internal (Google Workspace)
#       - Fill in App name, User support email, Developer contact email
#       - Add scopes: calendar.readonly, calendar.events (or just .../auth/calendar)
#       - Add your Google account as a Test User (required while app is in Testing)
#    e) Create OAuth Client Credentials:
#       APIs & Services → Credentials → Create Credentials → OAuth Client ID
#       - Application type: Desktop app
#       - Name it anything (e.g. "Calendar Local Test")
#       - Download the JSON → save as client_secret.json in this script's directory
#
# 3. Credentials — two options (script tries both, prefers env vars):
#    Option A (env vars):
#       set GOOGLE_CLIENT_ID=your_client_id_here
#       set GOOGLE_CLIENT_SECRET=your_client_secret_here
#    Option B (file):
#       Place client_secret.json (downloaded from Cloud Console) next to this script.
#
# 4. Redirect URI — for Desktop app type, Google handles the loopback automatically.
#    No extra redirect URI configuration is needed in Cloud Console for Desktop apps.
#
# 5. Run:
#    python google_calendar_oauth_test.py
#
# On first run: browser opens for consent → token.json is created.
# On subsequent runs: token.json is used (silent refresh, no browser).
#
# To force re-consent (e.g. to get a new refresh token):
#    Delete token.json and run again.
#
# To revoke access entirely:
#    Visit https://myaccount.google.com/permissions and remove the app.
# =============================================================================

import os
import sys
import json
import datetime
import socket
import webbrowser
import threading
import traceback
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
import http.client
import ssl
import base64
import hashlib
import secrets

# ── Third-party (install via pip) ────────────────────────────────────────────
try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
except ImportError:
    print("❌  Missing dependencies. Run:")
    print("    pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client")
    sys.exit(1)

# =============================================================================
# CONFIGURATION
# =============================================================================

# Scopes requested:
#   calendar.readonly  → read events (list upcoming)
#   calendar.events    → create + delete events
#
# We do NOT request the broad "calendar" scope (full access) to stay minimal.
# If you only need read access, remove calendar.events.
# "offline" access is handled by access_type="offline" in the flow, which
# instructs Google to return a refresh_token alongside the access_token.
SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    # userinfo.email lets us fetch the signed-in user's email address
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
]

SCRIPT_DIR = Path(__file__).parent.resolve()
TOKEN_FILE = SCRIPT_DIR / "token.json"
CLIENT_SECRET_FILE = SCRIPT_DIR / "client_secret.json"

# =============================================================================
# HELPERS
# =============================================================================

def separator(title: str = ""):
    line = "─" * 60
    if title:
        print(f"\n{line}")
        print(f"  {title}")
        print(f"{line}")
    else:
        print(line)


def load_client_credentials() -> tuple[str, str]:
    """
    Load OAuth client_id and client_secret from:
      1. Environment variables GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
      2. client_secret.json file (downloaded from Cloud Console)
    Returns (client_id, client_secret) or exits with a clear error.
    """
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()

    if client_id and client_secret:
        print("✅  Loaded credentials from environment variables.")
        return client_id, client_secret

    if CLIENT_SECRET_FILE.exists():
        try:
            data = json.loads(CLIENT_SECRET_FILE.read_text(encoding="utf-8"))
            # client_secret.json can have key "installed" (Desktop) or "web"
            info = data.get("installed") or data.get("web")
            if not info:
                print(f"❌  client_secret.json has unexpected structure (no 'installed' or 'web' key).")
                sys.exit(1)
            client_id = info.get("client_id", "")
            client_secret = info.get("client_secret", "")
            if client_id and client_secret:
                print(f"✅  Loaded credentials from {CLIENT_SECRET_FILE.name}.")
                return client_id, client_secret
        except json.JSONDecodeError as e:
            print(f"❌  Failed to parse {CLIENT_SECRET_FILE.name}: {e}")
            sys.exit(1)

    # Neither source worked — give actionable guidance
    print("❌  No OAuth credentials found.")
    print()
    print("  Option A — Set environment variables:")
    print("    set GOOGLE_CLIENT_ID=<your_client_id>")
    print("    set GOOGLE_CLIENT_SECRET=<your_client_secret>")
    print()
    print("  Option B — Place client_secret.json next to this script:")
    print(f"    Expected path: {CLIENT_SECRET_FILE}")
    print()
    print("  Get credentials at: https://console.cloud.google.com/apis/credentials")
    print("  Create an OAuth 2.0 Client ID → Application type: Desktop app")
    sys.exit(1)


def build_client_config(client_id: str, client_secret: str) -> dict:
    """
    Build the client_config dict that InstalledAppFlow expects.
    This mirrors the structure of a downloaded client_secret.json.
    We use "installed" (Desktop app) which supports the loopback flow.
    """
    return {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }


def load_or_refresh_credentials(client_id: str, client_secret: str) -> Credentials:
    """
    1. Try to load saved credentials from token.json.
    2. If they're expired, refresh them silently (no browser).
    3. If no saved credentials exist, run the browser-based OAuth consent flow.

    WHY offline access?
      access_type="offline" tells Google to issue a refresh_token alongside
      the short-lived access_token. Without it you'd have to re-authenticate
      every ~1 hour when the access_token expires.

    WHY prompt="consent"?
      Google only returns a refresh_token the FIRST time a user consents, OR
      when you explicitly request prompt="consent". If you lost your token.json
      without prompt="consent" you'd get no refresh_token on re-auth.
      We pass it here so every fresh auth always yields a refresh_token.
    """
    creds = None

    # ── Load existing token ───────────────────────────────────────────────────
    if TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
            print(f"✅  Loaded saved credentials from {TOKEN_FILE.name}.")
        except Exception as e:
            print(f"⚠️   Could not load {TOKEN_FILE.name}: {e}. Starting fresh auth.")
            creds = None

    # ── Refresh if expired ────────────────────────────────────────────────────
    if creds and not creds.valid:
        if creds.expired and creds.refresh_token:
            print("🔄  Access token expired — refreshing silently...")
            try:
                creds.refresh(Request())
                print("✅  Token refreshed successfully (no browser needed).")
                _save_token(creds)
            except Exception as e:
                print(f"⚠️   Token refresh failed ({e}). Re-running consent flow...")
                creds = None
        else:
            print("⚠️   Credentials invalid and no refresh token. Re-running consent flow...")
            creds = None

    # ── Full OAuth consent flow ───────────────────────────────────────────────
    if not creds or not creds.valid:
        print("\n🌐  Opening browser for Google Sign-In consent...")
        print("    (If the browser doesn't open, copy the URL printed below.)\n")

        client_config = build_client_config(client_id, client_secret)

        flow = InstalledAppFlow.from_client_config(
            client_config,
            scopes=SCOPES,
        )

        # run_local_server starts a temporary HTTP server on localhost,
        # launches the browser, waits for the OAuth redirect, and exchanges
        # the authorization code for tokens automatically.
        creds = flow.run_local_server(
            port=0,                  # OS picks a free port
            access_type="offline",   # ← request refresh_token
            prompt="consent",        # ← force refresh_token even if previously consented
            open_browser=True,
        )

        print("✅  OAuth consent completed.")
        _save_token(creds)

    return creds


def _save_token(creds: Credentials):
    """Persist credentials to token.json (no raw secret logged)."""
    try:
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
        print(f"💾  Credentials saved to {TOKEN_FILE.name}.")
    except Exception as e:
        print(f"⚠️   Could not save token: {e} (will need to re-authenticate next run).")


def get_user_email(creds: Credentials) -> str:
    """Fetch the signed-in user's email via the userinfo endpoint."""
    try:
        service = build("oauth2", "v2", credentials=creds)
        info = service.userinfo().get().execute()
        return info.get("email", "<email not available>")
    except Exception as e:
        return f"<could not fetch email: {e}>"


def print_auth_summary(creds: Credentials, email: str):
    separator("AUTHENTICATION SUMMARY")
    print(f"  Account email  : {email}")
    print(f"  Valid          : {creds.valid}")
    print(f"  Scopes granted : ")
    for s in (creds.scopes or SCOPES):
        print(f"    • {s}")
    has_refresh = bool(creds.refresh_token)
    print(f"  Refresh token  : {'✅  Yes (persistent auth works)' if has_refresh else '❌  No'}")
    if not has_refresh:
        print()
        print("  ⚠️  NO REFRESH TOKEN — most common reasons:")
        print("     1. You previously consented and Google doesn't resend it.")
        print("        Fix: Delete token.json, then revoke app access at")
        print("             https://myaccount.google.com/permissions, then re-run.")
        print("     2. access_type='offline' was missing in the auth request.")
        print("        Fix: Already set in this script — delete token.json & retry.")
        print("     3. OAuth consent screen is 'Internal' type with a service account.")
        print("        Fix: Use a Desktop app client ID for local testing.")


# =============================================================================
# CALENDAR OPERATIONS
# =============================================================================

def list_upcoming_events(service, max_results: int = 10) -> list[dict]:
    """
    List the next N upcoming events from the user's primary calendar.
    Returns list of event dicts (or empty list on failure).
    """
    separator("UPCOMING CALENDAR EVENTS")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        result = (
            service.events()
            .list(
                calendarId="primary",
                timeMin=now,
                maxResults=max_results,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        events = result.get("items", [])

        if not events:
            print("  (No upcoming events found in primary calendar.)")
        else:
            for i, evt in enumerate(events, 1):
                start = evt["start"].get("dateTime", evt["start"].get("date", "?"))
                print(f"  {i:>2}. [{start}]  {evt.get('summary', '(no title)')}")

        return events

    except HttpError as e:
        if e.resp.status == 403:
            print(f"  ❌  Permission denied listing events.")
            print(f"     Likely scope missing: https://www.googleapis.com/auth/calendar.readonly")
        else:
            print(f"  ❌  Calendar API error: {e}")
        return []


def create_test_event(service) -> str | None:
    """
    Create a 30-minute test event starting 10 minutes from now.
    Returns the event ID on success, or None on failure.

    NOTE: This script DELETES the event after creation (cleanup).
    If you'd rather keep it, change DELETE_AFTER_CREATE = False below.
    """
    DELETE_AFTER_CREATE = False  # ← set to False to keep the event

    separator("CREATE + DELETE TEST EVENT")

    now = datetime.datetime.now(datetime.timezone.utc)
    start_time = now + datetime.timedelta(minutes=10)
    end_time = start_time + datetime.timedelta(minutes=30)
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    summary = f"OAuth Test Event {timestamp}"

    event_body = {
        "summary": summary,
        "description": "Auto-created by google_calendar_oauth_test.py to verify Calendar write access. Safe to delete.",
        "start": {
            "dateTime": start_time.isoformat(),
            "timeZone": "UTC",
        },
        "end": {
            "dateTime": end_time.isoformat(),
            "timeZone": "UTC",
        },
    }

    try:
        print(f"  Creating event: \"{summary}\"")
        created = service.events().insert(calendarId="primary", body=event_body).execute()
        event_id = created.get("id")
        event_link = created.get("htmlLink", "(no link)")
        print(f"  ✅  Event created!")
        print(f"      ID  : {event_id}")
        print(f"      Link: {event_link}")

        if DELETE_AFTER_CREATE:
            try:
                service.events().delete(calendarId="primary", eventId=event_id).execute()
                print(f"  🗑️   Event deleted (cleanup). Your calendar is unchanged.")
            except HttpError as e:
                print(f"  ⚠️   Created event but couldn't delete it: {e}")
                print(f"      You may want to delete event ID {event_id} manually.")
        else:
            print(f"  📌  Event kept in your calendar (DELETE_AFTER_CREATE=False).")

        return event_id

    except HttpError as e:
        if e.resp.status == 403:
            print(f"  ❌  Permission denied creating event.")
            print(f"     Likely scope missing: https://www.googleapis.com/auth/calendar.events")
        else:
            print(f"  ❌  Failed to create event: {e}")
        return None


# =============================================================================
# MAIN
# =============================================================================

def main():
    separator("GOOGLE CALENDAR OAUTH TEST")
    print("  Testing: Sign-In + Calendar read/write + Refresh token persistence")

    # ── Step 1: Load credentials ──────────────────────────────────────────────
    separator("STEP 1 — Load Credentials")
    client_id, client_secret = load_client_credentials()

    # ── Step 2: Authenticate (or reuse saved token) ───────────────────────────
    separator("STEP 2 — Authenticate")
    try:
        creds = load_or_refresh_credentials(client_id, client_secret)
    except Exception as e:
        print(f"❌  Authentication failed: {e}")
        traceback.print_exc()
        sys.exit(1)

    # ── Step 3: Show auth summary ─────────────────────────────────────────────
    email = get_user_email(creds)
    print_auth_summary(creds, email)

    # ── Step 4: Build Calendar service ───────────────────────────────────────
    separator("STEP 3 — Connect to Google Calendar API")
    try:
        calendar_service = build("calendar", "v3", credentials=creds)
        print("  ✅  Google Calendar service initialized.")
    except Exception as e:
        print(f"  ❌  Failed to build Calendar service: {e}")
        sys.exit(1)

    # ── Step 5: List upcoming events ─────────────────────────────────────────
    events = list_upcoming_events(calendar_service, max_results=10)

    # ── Step 6: Create + delete test event ───────────────────────────────────
    event_id = create_test_event(calendar_service)

    # ── Final summary ─────────────────────────────────────────────────────────
    separator("FINAL SUMMARY")
    print(f"  Signed-in account      : {email}")
    print(f"  Refresh token present  : {'✅  Yes' if creds.refresh_token else '❌  No'}")
    print(f"  Calendar events listed : {'✅  Yes (' + str(len(events)) + ' events)' if events is not None else '❌  Failed'}")
    print(f"  Test event create/del  : {'✅  Success' if event_id else '❌  Failed'}")
    print(f"  Token persisted to     : {TOKEN_FILE}")
    print()

    all_ok = bool(creds.refresh_token and event_id is not None)
    if all_ok:
        print("  🎉  All checks passed. OAuth + Calendar access is working correctly.")
    else:
        print("  ⚠️   Some checks failed. Review the output above for details.")

    separator()


if __name__ == "__main__":
    main()
