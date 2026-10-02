import { createOnOffPref } from "./lib/onOffPref";

// On: the file panel's +/− header totals count only files not yet marked
// viewed — "how much is left to review" instead of "how big the diff is".
// Per-file numbers and the "N / M viewed" chip are unaffected.
const viewedStats = createOnOffPref("delta.viewedStatsExclude", "off");

export const getViewedStatsExclude = viewedStats.get;
export const setViewedStatsExclude = viewedStats.set;
export const useViewedStatsExclude = viewedStats.usePref;
