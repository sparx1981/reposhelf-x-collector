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

Two broad searches sample recent posts and a saved 90-day historical window. Each run rotates queries and requests one recent page and one historical page. Bounds and pagination cursors persist; gaps beyond the seven-day recent-search window are recorded. This is a sample, not exhaustive coverage. GitHub links must be in the post; links through unrelated articles are not followed.

Repositories are deduplicated case-insensitively. Source post links are retained without raw post text or author profiles. Ingestion merges existing RepoShelf listings.

Validation uses the pinned RepoShelf extractor, quality checks and submission qualifier, with the existing page-load standard. The separate browser process has no X credentials and uses RepoShelf's public-network guard. Live moderation controls are required. Login walls and temporary errors retry. There are no star, licence or category restrictions.

Acceptance requires a public repository checked within 48 hours, a working demo checked within seven days, a screenshot and no moderation restriction. Repository evidence refreshes after 36 hours. Trusted ingestion rechecks metadata, freshness and moderation, preserving normal categories and adding **As Seen On X.com**.

## Results

The public `collector-state` branch holds `state.json`, `approved.json`, `report.md`, and `previews/`. The workflow summary and **reposhelf-candidates** artifact contain the list and screenshots. No credentials belong in results.

`npm test` uses mocks and consumes no X credits.

References: [X search](https://docs.x.com/x-api/posts/search/introduction), [credit balance](https://docs.x.com/x-api/usage/get-usage-credits), [pricing and spending limits](https://docs.x.com/x-api/getting-started/pricing).
