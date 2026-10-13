# Gungnir

Schedule and publish posts to your clients' **Instagram**, **TikTok**, **YouTube** and
**Facebook** accounts from one place. It runs on a small server, so posts go out on time even
when everyone's laptop is closed. Your team uses it through the **Gungnir Mac app** or in any
browser. It connects to each platform directly through the platform's official publishing API.

It's built like [Orbit CRM](https://github.com/sethjallen24/Orbit-Crm) and
[Jormungandr](https://github.com/sethjallen24/Jormungandr): TypeScript and React, with a Node
server (Fastify) and a SQLite database.

## What it does

- **Clients and their accounts.**
  - Each client's accounts are connected once through the platform's own sign-in.
  - One Facebook login covers Facebook Pages and the Instagram professional accounts linked to
    them. You then pick which of that login's Pages and Instagram accounts belong to the client.
  - TikTok and YouTube connect one account (or channel) per sign-in.
  - Sign-ins are stored encrypted on the server.
- **Posts.**
  - Upload a video or photos once and write one caption.
  - Pick any of the client's accounts. Each account can override the caption and set its
    platform's options: YouTube title and visibility, TikTok privacy, comments and content
    disclosure, Instagram "also show the Reel in the grid".
  - Post now, schedule, or save a draft.
- **Checks before posting.** Each platform's rules are checked as you type, and again on the
  server:
  - caption lengths, and Instagram's 30-hashtag and 20-mention limits
  - which media each platform accepts (for example, Instagram only takes JPEG photos)
  - TikTok's per-account privacy options and maximum video length
  - YouTube needs a title
- **Publishing.**
  - A background scheduler publishes each account separately.
  - It saves progress after each step: uploads, waiting for the platform to process, and the
    final publish. A restart resumes instead of posting twice, and an interrupted YouTube
    upload continues where it stopped.
  - Rate limits and outages are retried with increasing waits.
  - An expired sign-in marks the account "Reconnect". Connect it again, then press **Try
    again** on the post.
- **Status.** Posts are listed as Upcoming, Drafts, Published and Failed. Each post shows every
  account's status, a link to the live post, any error, and a history of who did what.
- **Team.** The first person to open a new installation becomes an admin. Admins invite others
  with one-time links and can make them admins or remove their access.

### What each platform allows

| | Instagram | Facebook Page | YouTube | TikTok |
| --- | --- | --- | --- | --- |
| Video | Reel (3 s–15 min) | Video | Video (vertical ≤3 min becomes a Short) | Video (account's max length) |
| Photos | 1, or a carousel of up to 10 (JPEG) | 1–10 | — | — (not yet) |
| Text only | — | Yes | — | — |
| Caption | 2,200 chars, 30 hashtags, 20 @mentions | 63,206 chars | Title 100 chars, description 5,000 bytes | 2,200 chars |
| Daily limits | 100 API posts per account | — | 100 uploads per app (default quota) | About 15 posts per creator |

## Before it can post publicly: platform approval

Each platform must approve Gungnir (your copy of it, under your developer accounts) before it
can post to accounts other than your own test accounts. **Start these now. They take days to
weeks.** Until then:

- **Meta:** only people with a role on your Meta app (admins, developers, testers) can connect.
  Other accounts need App Review (Advanced Access) and Business Verification.
- **YouTube:** uploads are forced to **private** until Google audits the project. While the
  Google consent screen is in "Testing", sign-ins also expire after 7 days. Publish the consent
  screen to stop that.
- **TikTok:** posts can only be **private ("Only me")**, on accounts that are themselves set to
  private, and at most 5 accounts per day can post, until TikTok audits the app.

The composer already follows the posting-screen rules TikTok's audit checks:
- the creator's name is shown
- there's no default privacy setting
- comments, Duet and Stitch stay off unless chosen
- content disclosure is offered
- the Music Usage Confirmation notice is shown

## Setting up the platform apps

Each platform needs an app registered under your developer account. Each one gives you two
values to put in `.env` (copy `.env.example`). The redirect address for each is
`PUBLIC_URL/oauth/<provider>/callback`.

### Meta (Facebook Pages and Instagram)

1. At [developers.facebook.com](https://developers.facebook.com), create an app of type
   **Business**.
2. Add **Facebook Login for Business**.
3. Under its settings, add `PUBLIC_URL/oauth/meta/callback` as a valid OAuth redirect URI.
4. Request these permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish` and `business_management`.
   - Or create a Login configuration with them and put its ID in `META_CONFIG_ID`.
5. Put the App ID and App Secret in `META_APP_ID` and `META_APP_SECRET`.
6. Add your team as app testers. For other people's accounts, submit App Review for those
   permissions and complete Business Verification.

Instagram accounts must be **Business or Creator** accounts linked to a Facebook Page. The
person connecting must manage that Page.

### YouTube

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable
   **YouTube Data API v3**.
2. Set up the **OAuth consent screen** (External) with the scopes `youtube.upload` and
   `youtube.readonly`.
3. Create an **OAuth client ID** (Web application) with the redirect URI
   `PUBLIC_URL/oauth/google/callback`.
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. To post publicly, apply for the YouTube API audit
   ([Quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)).

### TikTok

1. At [developers.tiktok.com](https://developers.tiktok.com), create an app.
2. Add **Login Kit** and the **Content Posting API**, with **Direct Post** turned on.
3. Request the scopes `user.info.basic` and `video.publish`.
4. Add the redirect URI `PUBLIC_URL/oauth/tiktok/callback`. TikTok only accepts **https**
   addresses, so for local testing use a tunnel (below).
5. Put the client key and secret in `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
6. Apply for the Content Posting API audit to allow public posts.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 22 or newer.

```sh
npm ci
cp .env.example .env     # then fill in the platform keys you have
npm run dev              # server on :3000, web app on http://localhost:5173
```

Open the web app and create the admin account. A platform with no keys in `.env` shows as
"not set up yet" and can't be connected.

**A public https address.** Instagram fetches photos from Gungnir by link, and TikTok only
redirects to https addresses. So for real connections, run a tunnel and use its address as
`PUBLIC_URL` (and in each platform app's redirect URI). For example,
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
`cloudflared tunnel --url http://localhost:3000`. With a tunnel, use the built app (`npm run
build && npm start`) so everything is served from port 3000.

## Put it on a server

Gungnir runs as a plain Node app (no Docker). [Render](https://render.com) is set up for it in
`render.yaml`:

1. In Render, choose **New → Blueprint** and pick this repository.
2. Render asks for the values marked `sync: false`. Fill in the platform keys you have. Leave
   `PUBLIC_URL` blank unless you'll use your own domain. `SECRET_KEY` is generated for you.
3. Create it. Render builds it (`npm ci && npm run build`), starts it (`npm start`) and gives it
   an address like `https://gungnir-xxxx.onrender.com`.
4. **Open that address straight away and create your admin account.** The first person to open
   a new installation becomes its admin.
5. In each platform app (above), set the redirect URI to that address plus
   `/oauth/meta/callback`, `/oauth/google/callback` or `/oauth/tiktok/callback`.

The Blueprint uses the **Starter** plan with a 10 GB disk at `/var/data`, which holds the
database and uploaded files and survives deploys. The free plan won't work: free services sleep
when idle, so scheduled posts would be missed, and they can't have a disk. Render keeps daily
snapshots of the disk. Each push to `main` deploys again.

To use your own domain, add it in Render, set `PUBLIC_URL` to it (for example
`https://post.example.com`) and update the platforms' redirect URIs.

Other hosts work too if they run Node 22 and keep a persistent disk. Run `npm ci && npm run
build`, then `npm start`, and set:
- `PUBLIC_URL`: the site's https address.
- `DATA_DIR`: a folder on the persistent disk.
- `SECRET_KEY`: from `openssl rand -hex 32`. It encrypts the stored platform sign-ins; if it's
  lost, every account has to be connected again.
- `TRUST_PROXY=true` when it runs behind the host's proxy. This is automatic on Render, Fly.io and Railway.

Run a single instance, so only one scheduler publishes.

## The Mac app

To install the Mac app, paste this into Terminal:

```sh
cd ~ && { [ -d gungnir ] && git -C gungnir pull || git clone https://github.com/sethjallen24/gungnir; } && bash ~/gungnir/desktop/install-prebuilt-mac.sh
```

Like Jormungandr's installer, it needs no Node.js. It downloads the official Electron runtime,
checks its SHA-256 checksum, and adds the app files from `desktop/prebuilt/`. It then signs the
app ad hoc and installs `/Applications/Gungnir.app`. Run it again to update.

On first launch it asks for your server's address (for example `gungnir-xxxx.onrender.com`). It
remembers the address and your sign-in. To switch servers, choose **File → Change Server…**.

- **Connecting accounts** works inside the app. The Facebook, Google and TikTok sign-in pages
  open in its window. Other links open in your browser.
- **Failed posts** are counted on the Dock icon and in the window title. Each new failure also
  sends a notification; click it to open the post.
- **The server is down or restarting:** the app says so and offers **Try again**.
- **Open in Browser** (File menu, or ⇧⌘O) opens the current page in your browser.

The app lives in `desktop/`. After changing it, run `desktop/scripts/update-prebuilt.sh` and
commit `desktop/prebuilt/`.

## Tests

```sh
npm test                                              # unit tests: rules, chunking, encryption
npm run build && CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

For the Mac app: `cd desktop && npm ci && npm test`. Build the server first; on Linux, run the
test under `xvfb-run`. It starts the built server and checks that:
- the connect page refuses wrong addresses
- links to other sites go to the browser
- failed posts are counted
- the server address and sign-in are remembered
- the app recovers when the server is down

The end-to-end test runs the built server against stand-ins for the four platforms' APIs
(`tests/mock-platforms.mjs`) and drives the web app in Chromium. It covers setup, connecting
each platform, a video posted everywhere (including an interrupted YouTube upload that resumes),
a photo carousel, an expired sign-in with reconnect and retry, scheduling, the server's checks,
and team invites. The stand-ins follow each platform's documented request sequence. Test
against real accounts too before relying on it.

## How it's built

| Part | Where |
| --- | --- |
| Settings (environment variables, `.env`) | `src/server/config.ts` |
| Database schema | `src/server/db.ts` |
| API: sign-in, team, clients, media, posts | `src/server/app.ts` |
| Scheduler (claims due posts, runs publish steps, retries) | `src/server/scheduler.ts` |
| Platform sign-ins and publishing | `src/server/platforms/` (`meta.ts`, `google.ts`, `tiktok.ts`) |
| Platform rules, shared by the composer and the server | `src/shared/rules.ts` |
| Web app | `src/web/` |
| Mac app (window, connect page, failed-post badge) | `desktop/` |
| Render setup | `render.yaml` |

## Not built yet

- TikTok photo posts (they need a verified domain for TikTok to fetch from)
- Instagram Stories
- First comments
- An approval step before posts go out
- Pulling post statistics back, which could fill Jormungandr's metrics sheet
