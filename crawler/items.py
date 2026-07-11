from __future__ import annotations

import scrapy


class DiscoveredPostItem(scrapy.Item):
    board_id = scrapy.Field()
    external_post_id = scrapy.Field()
    canonical_url = scrapy.Field()
    title = scrapy.Field()
    author = scrapy.Field()
    category = scrapy.Field()
    created_at_raw = scrapy.Field()
    comment_count = scrapy.Field()
    is_notice = scrapy.Field()


class CommentItem(scrapy.Item):
    position = scrapy.Field()
    source_comment_id = scrapy.Field()
    parent_position = scrapy.Field()
    depth = scrapy.Field()
    author = scrapy.Field()
    content_html = scrapy.Field()
    content_text = scrapy.Field()
    created_at_raw = scrapy.Field()


class CapturedPostItem(scrapy.Item):
    board_id = scrapy.Field()
    external_post_id = scrapy.Field()
    canonical_url = scrapy.Field()
    outcome = scrapy.Field()
    title = scrapy.Field()
    author = scrapy.Field()
    category = scrapy.Field()
    created_at_raw = scrapy.Field()
    views = scrapy.Field()
    body_html = scrapy.Field()
    body_text = scrapy.Field()
    is_aa = scrapy.Field()
    comments = scrapy.Field()
    warnings = scrapy.Field()
    warc_record_id = scrapy.Field()
