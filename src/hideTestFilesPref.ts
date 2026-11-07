import { createOnOffPref } from "./lib/onOffPref";

// Review-wide file filter, shared by the toolbar and Settings → General.
// Both panes and file totals skip tests; viewed marks remain stored unchanged.
const hideTests = createOnOffPref("delta.hideTestFiles", "off");

export const getHideTestFiles = hideTests.get;
export const setHideTestFiles = hideTests.set;
export const useHideTestFiles = hideTests.usePref;
