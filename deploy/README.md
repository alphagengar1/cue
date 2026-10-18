# Deploying the Cue backend to AWS

One Lightsail instance (Ubuntu 24.04, $5/month plan: 1 GB RAM, 2 vCPU, 40 GB) running the
backend under systemd behind Caddy, which gives us automatic HTTPS on
`https://<static-ip>.sslip.io`. Lightsail over EC2 because it has a flat price, a one-click
static IP and firewall, and is covered by the same AWS credits. About 20 minutes end to end.

Files here:

| File | What it is |
|---|---|
| `setup.sh` | Idempotent server bootstrap: Node 22, Caddy, clone to `/opt/cue`, `npm ci`, Caddyfile, systemd unit. Rerun it to redeploy. |
| `cue-backend.service` | systemd unit. `Restart=always` with no start limit, because the Photon reply listener holds a long-lived connection. |
| `Caddyfile` | Reverse proxy template; `setup.sh` fills in the host and port. |
| `check.sh` | From your laptop: curls `https://<host>/api/state` with and without the token, CORS preflight, `/setup`. Prints PASS/FAIL. |

Nothing here reads or stores secrets. The server gets its keys from the `backend/.env` you copy over.

## Before you start

1. **Push your work.** `setup.sh` clones `main` from GitHub. Several backend files are still
   untracked locally (`backend/src/app.ts`, `photon.ts`, `decide.ts`, `recap.ts`, ...), so until
   they are committed and pushed the server would get a backend that cannot start.
   (Alternative without pushing: step 6b below rsyncs your working tree instead.)
2. **Fill in `backend/.env` locally**, since the same file goes to the server. Beyond
   `backend/.env.example` the server also needs:
   - `DEVICE_TOKEN`: a real value, not empty and not `change-me`. Locally it is empty right now
     (auth off for dev). Generate one with `openssl rand -hex 16`. The same value becomes
     `VITE_DEVICE_TOKEN` in the app build.
   - `OPENAI_API_KEY` for the decision gate (`backend/src/decide.ts`).
   - Photon: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `WEARER_PHONE`
     (`PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` are accepted as aliases).
   - Leave `PUBLIC_BASE_URL` empty: `setup.sh` sets it to the https URL on the server.
   - `PORT` stays `8787` (Caddy proxies to whatever `PORT` says, but the unit's description assumes 8787).

## Steps

1. **Create the instance.** AWS console, Lightsail, *Create instance*. Region: `us-west-2`
   (Oregon) is the closest to LA. Platform *Linux/Unix*, blueprint *OS Only*, *Ubuntu 24.04 LTS*.
   Plan: the $5/month one (1 GB RAM). Name it `cue-backend`. Create.
2. **Attach a static IP.** Lightsail, *Networking*, *Create static IP*, attach it to
   `cue-backend`. This is required: the hostname encodes the IP, so a changing IP would mean a
   new hostname and a new Even Hub build. Note the IP, call it `IP` below.
3. **Open HTTPS.** Instance page, *Networking* tab, IPv4 firewall: *Add rule*, application
   *HTTPS* (TCP 443). Leave SSH (22) and HTTP (80) in place; Caddy needs 80 for the certificate
   challenge.
4. **Get SSH working from your laptop.** Lightsail, *Account*, *SSH keys*, download the default
   key for the region (`LightsailDefaultKey-us-west-2.pem`), then:

   ```sh
   mv ~/Downloads/LightsailDefaultKey-us-west-2.pem ~/.ssh/lightsail.pem
   chmod 400 ~/.ssh/lightsail.pem
   ssh -i ~/.ssh/lightsail.pem ubuntu@IP
   ```

   (Lightsail's browser SSH works for steps 5 and 7, but step 6 needs scp from your laptop.)
5. **Bootstrap the server.** On the instance:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/alphagengar1/cue/main/deploy/setup.sh | sudo bash
   ```

   It picks the hostname `IP.sslip.io` by itself, installs everything, and ends with
   `WARN: no /opt/cue/backend/.env yet`. That is expected. If you have a real domain pointed at
   the IP, run it as `curl ... | sudo HOST=api.cue.example bash` instead.
6. **Copy your `.env`.** From your laptop, in the repo root:

   ```sh
   scp -i ~/.ssh/lightsail.pem backend/.env ubuntu@IP:/opt/cue/backend/.env
   ```

   6b. *Only if you skipped pushing:* ship the working tree instead of the clone.

   ```sh
   rsync -az --delete -e "ssh -i ~/.ssh/lightsail.pem" \
     --exclude node_modules --exclude dist --exclude .env --exclude '.git' \
     backend shared deploy ubuntu@IP:/opt/cue/
   ```

   `setup.sh` leaves a non-git `/opt/cue` alone, so rerunning it after an rsync is safe.
7. **Start the service.** On the instance, rerun the bootstrap. It now finds `.env`, sets
   `PUBLIC_BASE_URL`, warns if `DEVICE_TOKEN` or the OpenAI/Photon keys are missing, and starts
   the backend:

   ```sh
   sudo /opt/cue/deploy/setup.sh
   ```

   The last lines show the URL. Watch it boot with `journalctl -u cue-backend -f`; the first line
   is `[cue] listening on :8787 | ... | keys {...}` with `true` for every configured key.
8. **Check from your laptop.**

   ```sh
   deploy/check.sh IP
   ```

   All four lines should say PASS. It reads `DEVICE_TOKEN` from your local `backend/.env` for the
   authenticated call. The first HTTPS request can take 10 to 20 seconds while Caddy fetches the
   certificate; rerun if the first attempt times out.
9. **Build the glasses app against it.** In `app/.env`:

   ```sh
   VITE_BACKEND_URL=https://IP.sslip.io
   VITE_DEVICE_TOKEN=<the DEVICE_TOKEN from backend/.env>
   ```

   and put `https://IP.sslip.io` in the `network` whitelist in `app/app.json` (full origin, no
   wildcard). Then build and pack. The setup page for the laptop is `https://IP.sslip.io/setup`.

## Day to day

- **Logs:** `journalctl -u cue-backend -f` (backend), `journalctl -u caddy -f` (proxy, access log).
  `-n 200` for the last 200 lines, `--since "10 min ago"` to narrow.
- **Redeploy after a push:** on the instance, `sudo /opt/cue/deploy/setup.sh`. It pulls `main`,
  runs `npm ci`, and restarts. For a code-only change you can also do
  `cd /opt/cue && git pull && sudo systemctl restart cue-backend`.
- **Change a key:** edit `/opt/cue/backend/.env` on the server (or scp again), then
  `sudo systemctl restart cue-backend`.
- **Status / restart:** `systemctl status cue-backend`, `sudo systemctl restart cue-backend`.
  The unit restarts on crash after 3 s, forever, and starts on boot. Caddy does too.
- **Load the event:** the store is in memory, so a restart loses loaded events and briefs until
  the next `POST /api/events` from the setup page or the bundled files under `backend/data/`
  are loaded again. Reload the event after any restart before the demo.

## Cost and cleanup

The $5 plan is billed hourly against the credits. After the event: rotate `DEVICE_TOKEN`
(or stop the instance), and when the backend is no longer needed, delete the instance and
release the static IP (an unattached static IP is billed).
