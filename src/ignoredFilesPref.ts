import { createOnOffPref } from "./lib/onOffPref";

// On: files matched by .deltaignore are hidden from the diff pane, toggled by
// the eye button on the file tree's "Ignored (N)" group row. The tree keeps
// its Ignored group, so what's ignored stays discoverable — only the
// right-hand pane skips their cards.
const hideIgnored = createOnOffPref("delta.hideIgnoredFiles", "off");

export const getHideIgnoredFiles = hideIgnored.get;
export const setHideIgnoredFiles = hideIgnored.set;
export const useHideIgnoredFiles = hideIgnored.usePref;
