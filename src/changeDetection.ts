import { createOnOffPref } from "./lib/onOffPref";

// Off skips the background re-diff that offers the Refresh button; manual refresh still works.
const changeDetection = createOnOffPref("delta.changeDetection", "on");

export const getChangeDetection = changeDetection.get;
export const setChangeDetection = changeDetection.set;
export const useChangeDetection = changeDetection.usePref;
