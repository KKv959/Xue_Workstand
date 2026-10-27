import assert from "node:assert/strict";
import test from "node:test";
import { isVideoMetricMissing } from "../src/app/library/_components/library-view-utils";
import type { Video } from "../src/lib/types";

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: "video-1",
    platform: "douyin",
    accountId: "account-1",
    title: "测试视频",
    url: "https://www.douyin.com/video/1234567890",
    stats: { views: 0, likes: 100, comments: 0, favorites: 0, shares: 0 },
    hotScore: 0,
    relativeViewRate: 0,
    transcriptStatus: "not_started",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides
  };
}

test("legacy Douyin zero metrics are treated as not fetched", () => {
  const video = makeVideo();
  assert.equal(isVideoMetricMissing(video, "comments"), true);
  assert.equal(isVideoMetricMissing(video, "favorites"), true);
});

test("hydrated Douyin zero metrics are treated as real zeroes", () => {
  const video = makeVideo({
    statsHydration: {
      status: "complete",
      source: "opencli",
      checkedAt: "2026-09-14T00:00:00.000Z",
      missingFields: []
    }
  });
  assert.equal(isVideoMetricMissing(video, "comments"), false);
  assert.equal(isVideoMetricMissing(video, "favorites"), false);
});

test("Bilibili metrics keep their numeric zero behavior", () => {
  const video = makeVideo({ platform: "bilibili" });
  assert.equal(isVideoMetricMissing(video, "comments"), false);
  assert.equal(isVideoMetricMissing(video, "favorites"), false);
});
