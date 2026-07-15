from __future__ import annotations

import os

# Optional browser-TLS-fingerprint impersonation.
#
# Disabled by default (REDSTM_IMPERSONATE_BROWSER unset): the crawl and the login handshake
# keep their HTTP/1.1 request-header footprint (real Chrome UA, client hints, Sec-Fetch
# metadata) and Python's default OpenSSL TLS stack.
#
# When set to a curl_cffi target such as "chrome131", curl_cffi owns a *coherent* Chrome
# fingerprint — TLS/JA3 and HTTP/2 settings as well as the UA and client hints — for both the
# login handshake (crawler.session) and the Scrapy crawl (scrapy-impersonate download
# handler). That closes the residual TLS-layer fingerprint gap the header footprint alone
# cannot, and keeps login and crawl identical at every layer.
#
# It is gated behind a flag (and an optional dependency extra) because the impersonated
# fingerprint cannot be verified against the authenticated origin from CI: enabling it swaps
# the UA/header set for curl_cffi's own profile, so it must be validated behind a production
# canary before it becomes the default (see docs/10 runbook).
_ENV_VAR = "REDSTM_IMPERSONATE_BROWSER"


def impersonate_target() -> str:
    """Return the configured curl_cffi impersonation target, or "" when disabled."""
    return os.environ.get(_ENV_VAR, "").strip()
