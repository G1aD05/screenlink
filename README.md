# ScreenLink

Cross-device screen sharing via WebRTC + Socket.io. One computer hosts, another views — live video stream peer-to-peer, no plugins needed.

## How it works

1. **Host** opens the app → clicks **Share Screen** → gets a 6-digit code (refreshes every 5 min)
2. **Viewer** opens the same URL on any other device → switches to Viewer → enters the code, or picks it from the public list
3. WebRTC establishes a direct peer-to-peer video stream
4. Viewer can send URLs for the host to open in new tabs

No accounts, no login — anyone with the app URL can host or view, same as before.

## Sharing a broadcast to specific people

On the Viewer panel there's an optional **"Your Name"** field. It isn't an
account or a password — it's just a label a viewer can type in, remembered on
their device for next time. Nothing verifies it.

On the Host panel, under **Public Broadcast**, there's a matching **"Restrict
to specific names"** field. Enter one or more names (comma-separated, e.g.
`alice, bob`) and the broadcast becomes visible only to viewers whose "Your
Name" matches one of those — whether they're joining with the 6-digit code, or
finding it in the global/public broadcast list. Everyone else doesn't even see
it in the public list, and gets "You are not authorized to view this
broadcast" if they try the code directly. Leave the field blank and it behaves
exactly as before: anyone with the code (or browsing the public list) can join.

This is a lightweight allow-list, not authentication — since there's no login,
it can't stop someone from typing a different name than the one you expect.
It's meant for "don't clutter my coworkers' public list with this" and
"only the people I told about this can find it," not for keeping out someone
who's determined to guess a name. If you need real access control, pair it
with the existing per-session password field, which anyone joining still has
to know regardless of what name they type.

## Deploy to Render (free tier)

### Option A — render.yaml (recommended)
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your repo — Render reads `render.yaml` automatically
4. Deploy. Done.

### Option B — Manual
1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
4. Deploy

### After deploy
Your app will be live at `https://screenlink-xxxx.onrender.com` (or your custom domain).
Both computers visit that URL. Host shares screen, viewer enters code.

## Run locally

```bash
npm install
npm start
# Open http://localhost:3000
```

## Tech stack

- **Server**: Node.js + Express + Socket.io (signaling only)
- **Video**: WebRTC `getDisplayMedia` → peer-to-peer stream
- **No database** — sessions are in-memory, reset on redeploy
- **STUN**: Google public STUN servers (free, no config needed)

## Notes

- Screen sharing requires HTTPS in production — Render provides this automatically
- For localhost testing, Chrome allows `getDisplayMedia` on `http://localhost`
- The free Render tier sleeps after 15 min of inactivity (first load may be slow)
- For always-on use, upgrade to Render's paid tier or add a cron ping
