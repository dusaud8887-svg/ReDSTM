from __future__ import annotations

import os

from crawler.footprint import impersonate_target

BOT_NAME = "redstm"

SPIDER_MODULES = ["crawler.spiders"]
NEWSPIDER_MODULE = "crawler.spiders"


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    """Parse a bounded positive int from the environment; invalid values fall back."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


# Operator decision (2026-07-14): authenticated member archival ignores robots.txt.
# Request *starts* still honor the origin's published Crawl-delay via DOWNLOAD_DELAY=10.
# Disabling this also removes the per-process robots fetch, which stalled for minutes
# during origin degradation before any listing request could start.
ROBOTSTXT_OBEY = False
# Keep major version in lockstep with REDSTM_CLIENT_HINT_HEADERS below.
# 138 is a current-generation Chrome major for mid-2026; outdated majors are a bot tell.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)
# Browser-consistent negotiation headers. Accept-Encoding is intentionally left to Scrapy's
# HttpCompressionMiddleware so it advertises exactly what it can decode.
REDSTM_ACCEPT = (
    "text/html,application/xhtml+xml,application/xml;q=0.9,"
    "image/avif,image/webp,image/apng,*/*;q=0.8"
)
REDSTM_ACCEPT_LANGUAGE = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
REDSTM_CLIENT_HINT_HEADERS = {
    "sec-ch-ua": '"Google Chrome";v="138", "Chromium";v="138", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}
REDSTM_NAVIGATION_HEADERS = {
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
}
DEFAULT_REQUEST_HEADERS = {
    "Accept": REDSTM_ACCEPT,
    "Accept-Language": REDSTM_ACCEPT_LANGUAGE,
    **REDSTM_CLIENT_HINT_HEADERS,
    **REDSTM_NAVIGATION_HEADERS,
}

# --- Pacing & concurrency ---------------------------------------------------
# TypeMoon is a small gnuboard host that often dribbles PHP responses for tens of
# seconds. Staggered concurrency (2 default, operator-capped at 3) lets a second
# request start after DOWNLOAD_DELAY while the first is still streaming — that is
# not a burst of simultaneous opens. DOWNLOAD_DELAY=10 is the published Crawl-delay
# floor; AutoThrottle only slows further under load (never below the delay).
# Override: REDSTM_CONCURRENT_REQUESTS=1|2|3 (invalid values fall back to 2).
REDSTM_CONCURRENT_REQUESTS = _env_int("REDSTM_CONCURRENT_REQUESTS", 2, minimum=1, maximum=3)
CONCURRENT_REQUESTS = REDSTM_CONCURRENT_REQUESTS
CONCURRENT_REQUESTS_PER_DOMAIN = REDSTM_CONCURRENT_REQUESTS
DOWNLOAD_DELAY = 10.0
# Slight human-like spread above the 10s floor: Scrapy multiplies the delay by a
# random factor in [0.5, 1.5], which would go *below* Crawl-delay. Keep False and
# let AutoThrottle stretch the gap when the origin is already slow.
RANDOMIZE_DOWNLOAD_DELAY = False
AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 10.0
# Origin degradation regularly needs multi-minute gaps between starts; keep the floor at
# Crawl-delay and only stretch under load so a half-dead PHP worker is not hammered.
AUTOTHROTTLE_MAX_DELAY = 120.0
AUTOTHROTTLE_TARGET_CONCURRENCY = float(REDSTM_CONCURRENT_REQUESTS)

# --- Timeouts ----------------------------------------------------------------
# Long-lived archival against a flaky, slow gnuboard host prefers waiting over cutting
# off a body that is still dribbling. Two budgets for two body shapes:
# - listing: ~100–200 KiB HTML; still allow multi-minute streams under load.
# - detail (especially AA): multi-MB HTML that routinely needs several minutes.
# DOWNLOAD_TIMEOUT is the Scrapy default; per-request meta overrides it.
REDSTM_LISTING_TIMEOUT_SECONDS = 240
REDSTM_DETAIL_TIMEOUT_SECONDS = 420
DOWNLOAD_TIMEOUT = REDSTM_DETAIL_TIMEOUT_SECONDS

# First try + RETRY_TIMES retries. Flaky dribble/truncated bodies need one more
# chance than the old total of 3 when the origin stalls mid-stream then recovers.
RETRY_TIMES = 3
RETRY_HTTP_CODES = [408, 500, 502, 503, 504, 520, 522, 524]
DOWNLOAD_WARNSIZE = 8 << 20
DOWNLOAD_MAXSIZE = 64 << 20
# Truncated chunked bodies are common on this origin; retry in spider/middleware
# rather than hard-failing a multi-minute download.
DOWNLOAD_FAIL_ON_DATALOSS = False
COOKIES_ENABLED = True
TELNETCONSOLE_ENABLED = False
LOG_LEVEL = "INFO"

DOWNLOADER_MIDDLEWARES: dict[str, int | None] = {"crawler.middlewares.WarcCaptureMiddleware": 595}
ITEM_PIPELINES = {"crawler.archive_pipeline.ArchivePipeline": 300}

# Optional TLS/JA3 fingerprint impersonation (off unless REDSTM_IMPERSONATE_BROWSER is set).
# When enabled, curl_cffi's download handler serves requests carrying meta["impersonate"];
# it owns the full browser fingerprint, so the static header footprint is stood down to avoid
# contradicting the impersonated profile (e.g. our Windows client hints under a macOS Chrome
# TLS profile), and Scrapy's UserAgentMiddleware is disabled so curl_cffi supplies the UA.
REDSTM_IMPERSONATE_BROWSER = impersonate_target()
if REDSTM_IMPERSONATE_BROWSER:
    TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"
    DOWNLOAD_HANDLERS = {
        "http": "scrapy_impersonate.ImpersonateDownloadHandler",
        "https": "scrapy_impersonate.ImpersonateDownloadHandler",
    }
    DEFAULT_REQUEST_HEADERS = {}
    DOWNLOADER_MIDDLEWARES = {
        **DOWNLOADER_MIDDLEWARES,
        "scrapy.downloadermiddlewares.useragent.UserAgentMiddleware": None,
    }

REDSTM_WARC_PATH = ".data/warc/capture.warc.gz"
REDSTM_WARC_MAX_BYTES = 1 << 30
# Detail 420s × (1 + RETRY_TIMES) ≈ 28 min worst case per lease, plus processing room under
# staggered concurrency 2–3. Keep lease above that so reclaim does not steal a live download.
REDSTM_FRONTIER_LEASE_SECONDS = 2400
REDSTM_FRONTIER_MAX_ATTEMPTS = 5
REDSTM_FRONTIER_NETWORK_MAX_ATTEMPTS = REDSTM_FRONTIER_MAX_ATTEMPTS
REDSTM_CAPPED_RETRY_ERROR_CODES = frozenset({"network_error", "parse_drift", "storage_error"})
REDSTM_FRONTIER_BACKOFF_BASE_SECONDS = 120
REDSTM_FRONTIER_BACKOFF_CAP_SECONDS = 6 * 60 * 60
REDSTM_LISTING_OVERLAP_UNCHANGED = 20
REDSTM_INCREMENTAL_OVERLAP_PAGES = 2
# Match Scrapy download slots so recovery/detail in-flight never exceeds concurrency.
REDSTM_DETAIL_CONCURRENCY = REDSTM_CONCURRENT_REQUESTS
REDSTM_CIRCUIT_BREAKER_FAILURES = 3
REDSTM_PARSE_BREAKER_FAILURES = 3
REDSTM_RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60
# Full-catalog inventory spans many boards and multi-hour dribble windows. After a true
# site_unreachable cycle (no page progress on consecutive boards), the control runner waits
# and resumes the same pass instead of closing the command as failed on the first outage.
REDSTM_FULL_CATALOG_OUTAGE_RETRIES = 8
REDSTM_FULL_CATALOG_OUTAGE_BACKOFF_SECONDS = (90, 180, 300, 300, 420, 420, 600, 600)

# Session: origin login form can also dribble; preflight is more patient than form POST.
REDSTM_SESSION_TIMEOUT_SECONDS = 60.0
REDSTM_SESSION_PREFLIGHT_ATTEMPTS = 3
REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS = 120.0
REDSTM_SESSION_PREFLIGHT_RETRY_DELAY_SECONDS = 45
REDSTM_SESSION_LIFETIME_SECONDS = 4 * 60 * 60
REDSTM_SESSION_REVALIDATE_SECONDS = 30 * 60
REDSTM_AUTO_LOGIN_MIN_INTERVAL_SECONDS = 30 * 60
REDSTM_SESSION_HTML_MAX_BYTES = 8 << 20

REDSTM_SYNC_MAX_PAGES = 3
REDSTM_SYNC_MAX_POSTS = 20
REDSTM_CYCLE_MAX_PAGES = 3
# Inventory (full-catalog) passes walk every page of every board; a larger per-worker
# page budget amortizes Scrapy process startup without changing request pacing.
REDSTM_INVENTORY_MAX_PAGES = 40
REDSTM_CYCLE_MAX_POSTS = 20
REDSTM_CYCLE_TIME_BUDGET_SECONDS = 4 * 60 * 60
# Child Scrapy process grace after CLOSESPIDER_TIMEOUT so long AA finishes can close cleanly.
REDSTM_WORKER_GRACE_SECONDS = 120
REDSTM_RECOVERY_MAX_POSTS = 20
REDSTM_RECOVERY_TIME_BUDGET_SECONDS = 2 * 60 * 60
REDSTM_FULL_CONTENT_MAX_POSTS = 100
REDSTM_RECOVERY_GROUP_ORDER = ("aa", "creation", "fanfic")
REDSTM_EXPORT_WORKERS = 1
REDSTM_EXPORT_MAX_CHANGED_POSTS = 0
# Eligibility floor, not the end-to-end freshness target.
REDSTM_STALE_DETAIL_REVISIT_SECONDS = 30 * 24 * 60 * 60
REDSTM_STALE_DETAIL_RESERVED_POSTS = 1

REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
FEED_EXPORT_ENCODING = "utf-8"
