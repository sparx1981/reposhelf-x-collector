# RepoShelf collector for X

A separate GitHub Actions collector finds public GitHub links in X posts, reuses RepoShelf's demo extractor and page-load validator, captures screenshots, and exports quality-ready candidates. It uses no RepoShelf server for browser processing and no paid AI service.

## First run

1. Add the existing `X_BEARER_TOKEN` Actions secret. Keep X automatic recharge disabled; do not buy credits.
2. Open **Actions → Collect and validate X repositories → Run workflow**. Keep **Search X** checked. A run reads at most 50 posts, reserving at most $0.50 of the promotional balance.
3. Open the completed run. Read the summary and download **reposhelf-candidates** for `approved.json`, `report.md`, and screenshots.
4. After checking the pilot, enable daily searches with **Settings → Secrets and variables → Actions → Variables → New repository variable**: `X_COLLECTION_ENABLED=true`.

Without that variable, daily runs only refresh known candidates, making no X search calls. Unattended runs use standard public-repository GitHub runners. Scheduled Actions can be delayed and GitHub may disable schedules in inactive public repositories after 60 days; check Actions if collection stops.

## Strict £0 budget

The $20 promotional grant is temporary. Searches check `/2/usage/credits` before every metered request. Unknown balances, unknown/near expiry, insufficient free balance, or a negative prepaid balance stop collection. The collector reserves $0.01 per requested post, deliberately more than the current listed $0.005 post-read rate, with no expansions or user lookups. This is a safety allowance, not an exact bill. It stops at a $2 remaining balance or $18 lifetime reserved usage and never renews the allowance automatically.

Reservations are committed to the `collector-state` branch BEFORE search. A request that times out still consumes its allowance. Failure to save stops search. The API's actual balance remains the authoritative second gate. Keep the developer app dedicated to this collector; other apps spending on the same account, price changes, and auto-recharge settings are outside this code's control.

No payment, recharge or subscription endpoint is called. There is no paid fallback. Once credits expire or the cap is reached, daily validation can continue without X searches. Future discovery needs more free credits or another source.

## Search and validation

`config.json` contains two broad searches, a 90-day historical window, and small run limits. Each run rotates queries and requests one recent page and one historical page. Historical bounds and cursors persist. Daily recent pagination continues until drained; a gap exceeding the seven-day recent-search window is recorded. These limits yield a sample, not exhaustive coverage of all X posts. Initial discovery requires a GitHub link in the post; repos linked only through an unrelated article are not followed.

Repositories are deduplicated case-insensitively, including canonical aliases in the export. Source post links are preserved; post text and author profiles are not stored. Existing RepoShelf listings are merged during ingestion rather than duplicated.

Validation imports `dist/discovery.js`, `dist/quality.js`, and `scripts/submission-quality.mjs` from the pinned RepoShelf revision in the config. A separate browser process uses RepoShelf's public-network guard and does not receive X credentials. Current live moderation controls are required. Login walls and temporary browser errors are retried. There is no minimum star count, licence or category requirement, and no extra interaction tests beyond RepoShelf's current checks.

Acceptance requires public repository evidence within 48 hours, a working demo check within seven days, a captured screenshot, and moderation approval. Repository evidence refreshes after 36 hours; a still-fresh successful demo screenshot can be reused. The trusted RepoShelf ingestion workflow also refreshes repository metadata, checks freshness and current moderation, and preserves existing categories while adding **As Seen On X.com**.

## Durable results

The `collector-state` branch holds `state.json`, `approved.json`, `report.md`, and `previews/`. State survives short-lived Actions artifacts. `approved.json` is the trusted ingestion manifest; screenshots use RepoShelf's expected hashed JPEG names. All results on this public branch are public. No credentials belong in these files.

Run `npm test` locally. Tests mock X and browser results and consume no credits. Live X/browser verification happens only in the manual pilot; the secret is never needed in this chat.

References: [X search](https://docs.x.com/x-api/posts/search/introduction), [credit balance](https://docs.x.com/x-api/usage/get-usage-credits), [pricing](https://docs.x.com/x-api/getting-started/pricing).
