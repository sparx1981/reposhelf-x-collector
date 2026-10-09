# RepoShelf collector for X

A separate GitHub Actions collector finds GitHub links in X posts, validates hosted demos using RepoShelf's checks, captures screenshots and exports quality-ready candidates. Browser processing runs on GitHub.

## Administration and schedule

Apply RepoShelf migration 27 and deploy the administration update. Open **Administration → Sync → X.com scanning**. Scanning starts disabled. Enable it and save to allow searches at the next daily run at **06:17 UTC**, using free or purchased X API credits.

To run immediately, open **Actions → Collect and validate X repositories → Run workflow**, leaving **Search X** checked. Manual searches also require the toggle to be enabled. Uncheck Search X to refresh saved candidates only.

The old `X_COLLECTION_ENABLED` GitHub variable is no longer used. The collector checks RepoShelf's uncached public scanning status before every search. Unavailable or invalid settings prevent X requests. Disabling prevents subsequent searches but cannot cancel a request already sent. Demo validation of saved candidates continues while searches are disabled.

Keep `X_BEARER_TOKEN` in Actions secrets. No credentials are entered in RepoShelf administration. Standard public-repository GitHub runners handle unattended runs. Scheduled starts may be delayed; GitHub can disable schedules in inactive public repositories after 60 days.

## Spending controls

Set the maximum spend per billing cycle in the **X Developer Console**, and choose whether to enable auto-recharge there. X blocks API requests when its limit is reached or credits run out. Its documentation notes that balances can go slightly negative.

Before each search the collector checks `/2/usage/credits`, using total available balance, including free and purchased credits. Unknown or negative balances stop searches. It keeps a **$2 balance reserve**, reads at most **50 posts per run**, and reserves at most **$0.50 per run**, at $0.01 per requested post. These reservations are conservative, not exact charges. No expansions or user lookups are requested.

Reservations are committed to `collector-state` BEFORE search. Failed checkpoint writes prevent searches. HTTP 402, 403 and 429 stop the run without automatic retries. Timeouts retain reservations and cursors. Later scheduled runs check again, so added funds can permit scanning to resume. The former $18 lifetime pilot cap is removed; lifetime reservations remain an audit total.

The collector never purchases credits or changes billing settings. Other apps spending on the account, price changes and X's enforcement are outside this collector's control. Set your account spending ceiling before enabling purchased-credit scanning.

## Search and validation

Searches allocate approximately 70% of the post allowance to demo discovery and 30% to posts with at least ten likes or three reposts. Demo-focused GitHub queries rotate with a demo-host query. New query history stops seven days before initialization and recent coverage starts there; older saved cursors remain intact. Each query/endpoint has a bounded request allowance. Full long posts and public engagement counts are requested without expansions or user lookups.

Demo links are retained only with explicit demo/launch language. Posts with multiple repositories do not supply demo hints. Demo-first pages are inspected on public networks, at most five per normal run or ten for the larger test, and must link to exactly one GitHub repository. The same working-page, screenshot, freshness and moderation checks apply. Fresh candidates and demo evidence take priority; engagement adjusted for age breaks ties. Fresh existing RepoShelf evidence may be reused with its screenshot, without extending its validity.

The manual workflow offers a one-run **100-post / $1 conservative reservation** override, with up to 60 repository checks. Scheduled and ordinary manual runs remain **50 posts / $0.50 / 20 checks**. The $2 balance reserve always applies. Saved per-query totals appear in the candidate report. These totals include overlapping searches and are attributed to the first discovery query, rather than proving causal improvement.

Repositories are deduplicated case-insensitively. Source post links are retained without raw post text or author profiles. Ingestion merges existing RepoShelf listings.

Validation uses the pinned RepoShelf extractor, quality checks and submission qualifier, with the existing page-load standard. The separate browser process has no X credentials and uses RepoShelf's public-network guard. Live moderation controls are required. Login walls and temporary errors retry. There are no star, licence or category restrictions.

Acceptance requires a public repository checked within 48 hours, a working demo checked within seven days, a screenshot and no moderation restriction. Repository evidence refreshes after 36 hours. Trusted ingestion rechecks metadata, freshness and moderation, preserving normal categories and adding **As Seen On X.com**.

## Results

The public `collector-state` branch holds `state.json`, `approved.json`, `report.md`, and `previews/`. The workflow summary and **reposhelf-candidates** artifact contain the list and screenshots. No credentials belong in results.

`npm test` uses mocks and consumes no X credits.

References: [X search](https://docs.x.com/x-api/posts/search/introduction), [credit balance](https://docs.x.com/x-api/usage/get-usage-credits), [pricing and spending limits](https://docs.x.com/x-api/getting-started/pricing).
