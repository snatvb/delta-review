import { createOnOffPref } from "../lib/onOffPref";

const updateCheck = createOnOffPref("delta.updateCheck", "on");

export const getUpdateCheck = updateCheck.get;
export const setUpdateCheck = updateCheck.set;
export const useUpdateCheck = updateCheck.usePref;
