import { createOnOffPref } from "./lib/onOffPref";

// On: reviewOrder moves binary and giant-diff files to the end of the diff
// pane so readable diffs come first. Off (the default): plain tree order —
// the extra partition reshuffles cards as summaries update, which makes the
// pane's scroll jump mid-review.
const unreviewableLast = createOnOffPref("delta.unreviewableLast", "off");

export const getUnreviewableLast = unreviewableLast.get;
export const setUnreviewableLast = unreviewableLast.set;
export const useUnreviewableLast = unreviewableLast.usePref;
