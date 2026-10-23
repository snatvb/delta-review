import { createOnOffPref } from "./lib/onOffPref";

// On: files marked viewed are hidden from the diff pane, toggled by the
// CheckCheck button in the workspace toolbar (and Settings → General). The
// tree keeps its dimmed rows and checkboxes, so what's viewed stays
// reachable — only the right-hand pane skips their cards.
const hideViewed = createOnOffPref("delta.hideViewedFiles", "off");

export const getHideViewedFiles = hideViewed.get;
export const setHideViewedFiles = hideViewed.set;
export const useHideViewedFiles = hideViewed.usePref;
