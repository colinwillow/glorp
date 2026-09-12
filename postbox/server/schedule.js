// When to post. These are broad, well-worn engagement windows, not a trend
// feed — the point is a sane default that spreads the queue out, avoids
// clustering, and respects the cadence rules in BRAIN.md. Times are local.

export const WINDOWS = {
  instagram_feed:  [{ days: [1,2,3,4,5], hours: [11, 18, 19] }, { days: [0,6], hours: [10, 11, 19] }],
  instagram_reel:  [{ days: [1,2,3,4,5], hours: [12, 19, 21] }, { days: [0,6], hours: [11, 20] }],
  tiktok:          [{ days: [1,2,3,4,5], hours: [7, 12, 19, 22] }, { days: [0,6], hours: [10, 20] }],
  x:               [{ days: [1,2,3,4,5], hours: [9, 12, 17] }, { days: [0,6], hours: [11] }],
  youtube_shorts:  [{ days: [1,2,3,4,5], hours: [15, 20] }, { days: [0,6], hours: [10, 16] }],
  linkedin:        [{ days: [2,3,4], hours: [8, 12] }],
};

export const CADENCE = { perWeek: 3, minGapHours: 6, avoidSameProjectBackToBack: true };

function slotsFrom(start, platform, days = 21) {
  const out = [];
  const windows = WINDOWS[platform] || WINDOWS.instagram_feed;
  for (let d = 0; d < days; d++) {
    const day = new Date(start); day.setDate(day.getDate() + d); day.setMinutes(0, 0, 0);
    for (const w of windows) {
      if (!w.days.includes(day.getDay())) continue;
      for (const h of w.hours) {
        const t = new Date(day); t.setHours(h);
        if (t > start) out.push(t);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// Assigns a time to every post in `queue` that lacks one, given the posts
// already scheduled. Returns the queue with scheduledAt filled in.
export function planQueue(queue, { existing = [], now = new Date(), cadence = CADENCE } = {}) {
  const taken = existing.filter(p => p.scheduledAt).map(p => ({ t: new Date(p.scheduledAt), platform: p.platform, project: p.project }));
  const spacing = (7 * 24) / cadence.perWeek; // hours between posts at the target cadence
  let cursor = new Date(now);
  for (const post of queue) {
    if (post.scheduledAt) { taken.push({ t: new Date(post.scheduledAt), platform: post.platform, project: post.project }); continue; }
    const slots = slotsFrom(cursor, post.platform || 'instagram_feed');
    const pick = slots.find(t => {
      const sameDayGap = taken.every(x => x.platform !== post.platform || Math.abs(x.t - t) / 36e5 >= cadence.minGapHours);
      const cadenceGap = taken.filter(x => x.platform === post.platform).every(x => Math.abs(x.t - t) / 36e5 >= spacing * 0.8);
      const prev = taken.filter(x => x.t < t).sort((a, b) => b.t - a.t)[0];
      const projectOk = !cadence.avoidSameProjectBackToBack || !prev || prev.project !== post.project || !post.project;
      return sameDayGap && cadenceGap && projectOk;
    }) || slots[0];
    post.scheduledAt = pick.toISOString();
    taken.push({ t: pick, platform: post.platform, project: post.project });
    cursor = new Date(pick.getTime() + 60 * 60 * 1000);
  }
  return queue;
}
