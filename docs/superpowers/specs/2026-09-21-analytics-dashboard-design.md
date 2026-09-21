# Analytics Section from Google Analytics

**Date:** 2026-09-21
**Status:** Approved

## Problem

The dashboard manages 468 movies with no information about which ones anyone watches.

The data exists. The Android app (`movie-recap-app`) has logged events to Google Analytics
through Firebase since its first commit on 2026-02-06, into the GA4 property linked to the
same Firebase project the dashboard uses (`movie-recap-1306e`). Nothing reads it back. The
dashboard's `config.js` carries the web measurement ID `G-D03ZRJWX1F` but never initializes
Analytics, so there is no analytics code here at all.

## Goal

A section in the dashboard that shows how movies perform and who is using the app, built from
that Google Analytics data and joined to the movie library the dashboard already holds.

## Non-goals

- Tracking individuals. The app has no accounts; GA's users are anonymous app installs, and
  every figure here is an aggregate.
- Changing what the app logs. Two defects in its logging are recorded under Known issues; they
  are fixed in the app, not here.
- Real-time numbers. GA takes 24–48 hours to finish processing a day.
- Protecting the endpoint. Like the rest of the dashboard it has no login (see Out of scope).

## What the app logs

Confirmed by reading `app/src/.../util/AnalyticsManager.kt` and every call site:

| Event | Fired from | Parameters |
|---|---|---|
| `select_content` | Home and All Movies, 10 call sites | `content_type` = "movie", `item_id`, `item_name` |
| `video_start` | Detail screen, 3 call sites | `movie_id`, `movie_title` |
| `video_complete` | Detail screen, on playback end | `movie_id`, `movie_title`, `duration` |
| `view_category` | Home screen | `category_name` |
| `screen_view` | Home, Detail, All Movies | `screen_name`, `screen_class` |
| `ad_reward_earned` | nowhere — defined, never called | `movie_title` |

Every movie id logged is `movie.id`, the same `id` field the dashboard writes to
`movies/{id}`, so GA's movie ids join to the library directly. Clicks carry the id as `item_id`
while plays and completions carry it as `movie_id`: two different custom dimensions.

GA4 also records its automatic events (first open, sessions, engagement) with country,
language, OS version and app version, which is where the audience figures come from.

**Custom parameters are only reportable once registered.** The Data API can break data down by
`movie_id`, `item_id` or `category_name` only after each is registered as an event-scoped custom
dimension in GA4, and registration is not retroactive: breakdowns exist from the day it is done.
Audience and device figures are built in and cover the full history regardless.

## Design

### 1. The section

A **📊 Analytics** nav item and view, with a **7 / 28 / 90 day** range picker defaulting to 28.
Ranges run from `{N}daysAgo` to `yesterday`: today is always incomplete in GA, so including it
would make every trend end in a false dip.

| Section | Contents | Source |
|---|---|---|
| **Audience** | Tiles: active users, new users, sessions, average engagement per active user. A daily active users trend chart. | Built in |
| **Movie performance** | A table ranked by plays: thumbnail and title, clicks, plays, completions, completion rate, comments in the range. Then "No plays in this period: N movies", expandable to the list. | `item_id`, `movie_id`; comments from the database |
| **Categories** | Categories ranked by views, as bars. | `category_name` |
| **Where & devices** | Four ranked lists: countries, languages, Android versions, app versions. Top 10 each, by active users. | Built in |

In the movie table:

- **Completion rate** is completions ÷ plays, shown as "—" when a movie has no plays.
- **Clicks** needs `item_id` registered, and **plays and completions** need `movie_id`. With only
  `movie_id`, the table still ranks by plays and the Clicks column shows "—". With only `item_id`,
  there is nothing to rank by, so the table is not shown.
- **No plays in this period** lists every library movie with zero plays in the range, including
  ones added during it.
- **Movies since removed from the library** still have GA history. Their plays are summed into one
  line under the table rather than shown as rows with no title or thumbnail.
- **Comments** counts top-level comments whose timestamp falls in the range, from the comments tree
  the Comments section already keeps loaded. It needs no GA setup and covers the full history.

Charts are inline SVG and CSS bars. The project has no build step and two runtime
dependencies, and one line chart and some ranked bars do not justify a charting library.

Data is fetched when the Analytics view is first opened and when the range changes — never on
page load, so the rest of the dashboard stays as fast as it is and no quota is spent unless the
section is used.

### 2. Architecture

```
Browser ──GET /api/analytics?range=28──▶ api/analytics.js ──▶ GA4 Data API
   │                                      (service account,     (getMetadata,
   │                                       read-only scope)      batchRunReports)
   └── analytics.js joins GA movie ids ⟷ library: titles, thumbnails, never played
```

**`api/analytics.js`** — the endpoint. `GET` with `range` of 7, 28 or 90.

- Authenticates with **`google-auth-library`**, Google's official package and the one new
  dependency, using a service account and the `https://www.googleapis.com/auth/analytics.readonly`
  scope. It calls the Data API over REST with `fetch`; the gRPC client is not needed.
- Reads `GET https://analyticsdata.googleapis.com/v1beta/properties/{id}/metadata` to learn
  which custom dimensions are registered. Registered ones appear as `customEvent:{param}`. The
  result is held in module memory for an hour per warm instance.
- Sends the reports as `POST .../properties/{id}:batchRunReports`, which accepts at most **5
  reports per batch**, so they go as two batches in parallel.
- Takes its access token and `fetch` as injected dependencies through an exported
  `createHandler({ getAccessToken, fetch })`, so tests need neither credentials nor network.
  The default export is `createHandler` wired to the real ones.
- Sets `Cache-Control: s-maxage=900, stale-while-revalidate=3600` on success, so Vercel's edge
  serves repeat loads for 15 minutes without spending quota. Errors are `no-store`.

**`api/_ga-reports.js`** — the report definitions and the parsing of GA's responses into plain
objects. Pure, so unit-tested. The leading underscore keeps Vercel from deploying it as an
endpoint, the same convention as `api/_ytdlp.js`.

**`analytics.js`** (root) — the browser-side pure logic: joining GA movie ids to the library,
completion rates, the never-played list, comments in range. It imports nothing and is
unit-tested, following `comments.js`.

**View routing** — the router from the Comments feature assumes two views: one
`is-comments-view` class and a boolean. A third view is the point to generalize it, so
`.main-content` carries a single `data-view` attribute (`movies`, `comments`, `analytics`) and
CSS hides the movies view's parts whenever it is not `movies`. The same technique as before —
the last-added panel re-shows itself on a timer, so it is overridden from the ancestor rather
than toggled — extended to three views.

### 3. The reports

All use the date range `{startDate: '{N}daysAgo', endDate: 'yesterday'}`.

| # | Report | Dimensions | Metrics | Filter / limit |
|---|---|---|---|---|
| 1 | Audience totals | — | `activeUsers`, `newUsers`, `sessions`, `userEngagementDuration` | — |
| 2 | Daily active users | `date` | `activeUsers` | ordered by date |
| 3 | Countries | `country` | `activeUsers` | top 10 |
| 4 | Languages | `language` | `activeUsers` | top 10 |
| 5 | Android versions | `operatingSystemVersion` | `activeUsers` | top 10 |
| 6 | App versions | `appVersion` | `activeUsers` | top 10 |
| 7 | Movie clicks | `customEvent:item_id` | `eventCount` | `eventName` = `select_content`; all rows |
| 8 | Plays and completions | `eventName`, `customEvent:movie_id` | `eventCount` | `eventName` in `video_start`, `video_complete`; all rows |
| 9 | Categories | `customEvent:category_name` | `eventCount` | `eventName` = `view_category`; all rows |

"All rows" means no `limit`: GA's default is 10,000 rows, against 468 movies and about a dozen
categories.

Reports 7–9 are sent only if their custom dimensions are registered. Requesting an unregistered
dimension fails the whole batch, so the metadata check is what keeps the rest working.

Average engagement per active user is `userEngagementDuration / activeUsers`, in seconds.

### 4. The response

```json
{
  "range": 28,
  "audience": {
    "activeUsers": 0, "newUsers": 0, "sessions": 0, "engagementSeconds": 0,
    "daily": [{ "date": "2026-09-01", "activeUsers": 0 }]
  },
  "where": { "countries": [{ "name": "", "users": 0 }], "languages": [], "osVersions": [], "appVersions": [] },
  "movies": { "clicks": { "<movieId>": 0 }, "plays": {}, "completes": {} },
  "categories": [{ "name": "", "views": 0 }],
  "missingDimensions": ["movie_id"],
  "notes": { "thresholded": false, "otherRow": false }
}
```

- `movies` is `null` unless `movie_id` is registered. Within it, `clicks` is `null` unless
  `item_id` is too. `categories` is `null` unless `category_name` is registered.
- `missingDimensions` lists the unregistered ones by **parameter name** — `"movie_id"`, not
  `"customEvent:movie_id"` — since that is what the admin types into GA4.
- `notes.thresholded` reflects GA's `subjectToThresholding`: when true, GA withheld rows too
  small to report for privacy. `notes.otherRow` reflects `dataLossFromOtherRow`: some values were
  rolled into an "(other)" row. Either is shown as a short note, since both make totals
  undercount without saying so.

### 5. States

The section is useful before setup is finished, and every failure says what to do.

| Situation | Endpoint | Shown |
|---|---|---|
| No `GA_PROPERTY_ID` or `GA_SERVICE_ACCOUNT_KEY` | 503 `not_configured` | A setup card with the steps below |
| Service account not added to the property | 403 `no_access`, with the service account's email | "Add *email* as a Viewer in GA4 → Property access management" |
| Some or all custom dimensions not registered | 200, with the affected fields `null` | Audience and devices as normal; each affected section names the dimensions to register, and says data starts from registration |
| `range` not 7, 28 or 90 | 400 | — (the picker cannot send one) |
| Any other GA error | 502 with GA's message | The message and a Retry button |

### 6. Setup

Needed once, in the Google consoles:

1. **Property ID.** GA4 → Admin → Property settings. The number, not the `G-…` measurement ID.
2. **Enable the API.** Google Cloud console, project `movie-recap-1306e` → APIs & Services →
   enable **Google Analytics Data API**.
3. **Service account.** IAM & Admin → Service accounts → create one (for example
   `dashboard-analytics`) with no project roles → Keys → Add key → JSON. Download it.
4. **Grant read access.** GA4 → Admin → Property access management → add the service account's
   email with the **Viewer** role. Viewer can read reports and nothing else.
5. **Register custom dimensions** — GA4 → Admin → Custom definitions → Create custom dimension,
   scope **Event**, for each of `item_id`, `movie_id` and `category_name`. Do this first: every
   day before it is a day of per-movie data that can never be recovered.
6. **Configure.** Set `GA_PROPERTY_ID` to the number, and `GA_SERVICE_ACCOUNT_KEY` to the key
   file base64-encoded on one line (`base64 -i key.json | tr -d '\n'`). In `.env` locally, and in
   the Vercel project's environment variables.

Base64 because `dev-server.js` reads `.env` line by line, and a pretty-printed key file spans
many lines. The key is a credential: `.env` is already gitignored and the key must never be
committed.

## Testing

- **`analytics.test.js`** — joining GA ids to the library, completion rate (including zero
  plays), never-played list, movies GA reports that are no longer in the library, comments counted
  within the range.
- **`api/_ga-reports.test.js`** — each report's dimensions, metrics and filters; which reports
  are dropped for each missing dimension; parsing rows, empty reports, and the thresholding flags.
- **`api/analytics.test.js`** — the handler through `createHandler` with a fake token and a
  stubbed `fetch`: not configured, bad range, no access, missing dimensions, the full response,
  and cache headers.
- **Headless Chrome.** Reading analytics writes nothing, so unlike the reply and delete flows it
  can be exercised end to end against the real property once credentials exist. Before that, the
  not-configured setup card is what gets verified.

## Known issues (in the app, not fixed here)

- **Plays may be double-counted.** `video_start` fires both from the play button and from the
  fullscreen button (`DetailScreen.kt`), so a viewer who plays then goes fullscreen logs two
  starts. That inflates plays and deflates completion rate. The table carries a footnote.
- **`ad_reward_earned` never fires.** It is defined in `AnalyticsManager` but no screen calls it,
  so rewarded-ad activity cannot be reported.

## Known risks

- **Thresholding.** With a modest user count, GA may withhold small rows — a country with a
  handful of users, say. Surfaced through `notes.thresholded` rather than hidden.
- **Quota.** The Data API meters tokens per property per day. Fetching only when the section is
  open and caching for 15 minutes keeps normal use far inside it.

## Out of scope

`/api/analytics` has no authentication, like every other endpoint and the dashboard itself.
Anyone with the URL could read the aggregate figures. The service account key never leaves the
server and grants read-only access, so the exposure is the numbers, not the account.
