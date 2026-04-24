"""SEC EDGAR filings — public Atom feed with contact-UA compliance.

The SEC publishes the ``getcurrent`` Atom feed at a stable URL, but it
enforces its `Accessing EDGAR Data` rules strictly: any request whose
``User-Agent`` does not include a contact e-mail is rejected with a
``403 Forbidden``. We therefore *override* the shared Chrome UA here
via ``make_client(user_agent=...)`` rather than just appending an
``extra_headers`` banner — the previous attempt only added headers, so
the Chrome UA was still the one SEC saw, and every fetch came back as
``auth`` errors in the drawer.

Reference: https://www.sec.gov/os/accessing-edgar-data
"""

from __future__ import annotations

import logging
import re
from typing import Any

from finpulse_fetchers._http import fetch_text, make_client
from finpulse_fetchers.base import BaseFetcher, NormalizedItem
from finpulse_fetchers.rss import parse_feed


_EDGAR_RSS = (
    "https://www.sec.gov/cgi-bin/browse-edgar"
    "?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom"
)

# Minimum-viable UA pattern the SEC accepts — "Name email@example.com".
# We keep the check loose (presence of an ``@`` + a dot in the trailing
# token) so operators can paste either a company name or a personal
# handle in front of the contact address.
_EMAIL_RE = re.compile(r"[\w.\-+]+@[\w\-]+\.[\w.\-]+")

logger = logging.getLogger(__name__)


class SecEdgarFetcher(BaseFetcher):
    source_id = "sec_edgar"

    async def fetch(self, **_: Any) -> list[NormalizedItem]:
        contact = (self._config.get("sec_edgar.contact") or "").strip()
        if not _EMAIL_RE.search(contact):
            # Surface the config problem via a classifiable ImportError
            # substitute — ``map_exception`` treats ``Missing ... contact``
            # strings as "auth" so the drawer tells the user to set
            # ``sec_edgar.contact`` instead of silently 403-ing.
            raise RuntimeError(
                "SEC EDGAR rejects generic UAs — set sec_edgar.contact to "
                "'Your Name your-email@example.com' per "
                "https://www.sec.gov/os/accessing-edgar-data"
            )

        async with make_client(
            timeout=self._timeout_sec,
            user_agent=contact,
            extra_headers={
                "Accept-Encoding": "gzip, deflate",
                "Host": "www.sec.gov",
            },
        ) as client:
            body = await fetch_text(client, _EDGAR_RSS)
        items = parse_feed(self.source_id, body)
        if not items:
            logger.info("sec_edgar feed returned 0 rows (parser=%s)", "stdlib")
        return items


__all__ = ["SecEdgarFetcher"]
