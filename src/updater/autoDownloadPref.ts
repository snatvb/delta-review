import { createOnOffPref } from "../lib/onOffPref";

// Off by default: downloading tens of MB unprompted is opt-in. When on, a
// found update starts downloading immediately (see useUpdater) and the banner
// jumps straight to "Restart now".
const autoDownload = createOnOffPref("delta.updateAutoDownload", "off");

export const getAutoDownload = autoDownload.get;
export const setAutoDownload = autoDownload.set;
export const useAutoDownload = autoDownload.usePref;
