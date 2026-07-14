BOT_NAME = "redstm"

SPIDER_MODULES = ["crawler.spiders"]
NEWSPIDER_MODULE = "crawler.spiders"

# Operator decision (2026-07-14): authenticated member archival ignores robots.txt.
# Request pacing still honors the origin's published Crawl-delay via DOWNLOAD_DELAY=10.
# Disabling this also removes the per-process robots fetch, which stalled for minutes
# during origin degradation before any listing request could start.
ROBOTSTXT_OBEY = False
# The archive requests the same pages a logged-in member sees in a browser, so it presents
# a browser footprint rather than a self-identifying bot token, which gnuboard/Apache WAFs
# and rate limiters commonly filter. Login and crawl share this exact string (crawl_cycle
# passes USER_AGENT into the session handshake) so the whole footprint stays consistent.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
# Browser-consistent negotiation headers. Accept-Encoding is intentionally left to Scrapy's
# HttpCompressionMiddleware so it advertises exactly what it can decode.
REDSTM_ACCEPT = (
    "text/html,application/xhtml+xml,application/xml;q=0.9,"
    "image/avif,image/webp,image/apng,*/*;q=0.8"
)
REDSTM_ACCEPT_LANGUAGE = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
DEFAULT_REQUEST_HEADERS = {"Accept": REDSTM_ACCEPT, "Accept-Language": REDSTM_ACCEPT_LANGUAGE}
CONCURRENT_REQUESTS = 1
CONCURRENT_REQUESTS_PER_DOMAIN = 1
DOWNLOAD_DELAY = 10.0
DOWNLOAD_TIMEOUT = 180
RANDOMIZE_DOWNLOAD_DELAY = False
AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 10.0
AUTOTHROTTLE_MAX_DELAY = 60.0
AUTOTHROTTLE_TARGET_CONCURRENCY = 1.0
RETRY_TIMES = 2
RETRY_HTTP_CODES = [408, 500, 502, 503, 504, 522, 524]
DOWNLOAD_WARNSIZE = 8 << 20
DOWNLOAD_MAXSIZE = 64 << 20
DOWNLOAD_FAIL_ON_DATALOSS = False
COOKIES_ENABLED = True
TELNETCONSOLE_ENABLED = False
LOG_LEVEL = "INFO"

DOWNLOADER_MIDDLEWARES = {"crawler.middlewares.WarcCaptureMiddleware": 595}
ITEM_PIPELINES = {"crawler.archive_pipeline.ArchivePipeline": 300}
REDSTM_WARC_PATH = ".data/warc/capture.warc.gz"
REDSTM_WARC_MAX_BYTES = 1 << 30
REDSTM_FRONTIER_LEASE_SECONDS = 900
REDSTM_FRONTIER_MAX_ATTEMPTS = 5
REDSTM_FRONTIER_NETWORK_MAX_ATTEMPTS = REDSTM_FRONTIER_MAX_ATTEMPTS
REDSTM_CAPPED_RETRY_ERROR_CODES = frozenset({"network_error", "parse_drift", "storage_error"})
REDSTM_FRONTIER_BACKOFF_BASE_SECONDS = 120
REDSTM_FRONTIER_BACKOFF_CAP_SECONDS = 6 * 60 * 60
# Aligned with the detail timeout: the origin routinely streams listing pages for
# minutes under load, and 120s cut off slow-but-completing responses too early.
REDSTM_LISTING_TIMEOUT_SECONDS = 180
REDSTM_LISTING_OVERLAP_UNCHANGED = 20
REDSTM_INCREMENTAL_OVERLAP_PAGES = 2
REDSTM_DETAIL_CONCURRENCY = 1
REDSTM_CIRCUIT_BREAKER_FAILURES = 3
REDSTM_PARSE_BREAKER_FAILURES = 3
REDSTM_RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60

REDSTM_SESSION_TIMEOUT_SECONDS = 30.0
REDSTM_SESSION_PREFLIGHT_ATTEMPTS = 2
REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS = 60.0
REDSTM_SESSION_PREFLIGHT_RETRY_DELAY_SECONDS = 30
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
REDSTM_WORKER_GRACE_SECONDS = 60
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
