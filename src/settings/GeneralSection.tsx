import { useEditorPref, EDITORS, type EditorId } from "../editor";
import { usePickerOpenMode, type PickerOpenMode } from "../windowMode";
import { useWindowPerBranch } from "../windowPerBranch";
import { useChangeDetection } from "../changeDetection";
import { useViewedStatsExclude } from "../viewedStatsPref";
import { useUpdateCheck } from "../updater/updateCheckPref";
import { useAutoDownload } from "../updater/autoDownloadPref";
import { Chevron, Divider, OnOffToggle, Row, selectClass } from "./controls";

// General: how reviews open, how the app reacts to file changes, and updates.
// The window-per-branch pref is refreshed from the backend every time the
// dialog opens (see SettingsDialog) — here we only read and write it.
export function GeneralSection() {
  const [editor, setEditor] = useEditorPref();
  const [openMode, setOpenMode] = usePickerOpenMode();
  const [windowPerBranch, setWindowPerBranch] = useWindowPerBranch();
  const [changeDetection, setChangeDetection] = useChangeDetection();
  const [excludeViewed, setExcludeViewed] = useViewedStatsExclude();
  const [updateCheck, setUpdateCheck] = useUpdateCheck();
  const [autoDownload, setAutoDownload] = useAutoDownload();

  return (
    <div>
      <Row
        label="External editor"
        hint="Used by the “open in editor” buttons."
        control={
          <div className="relative">
            <select
              aria-label="External editor"
              value={editor}
              onChange={(e) => setEditor(e.target.value as EditorId)}
              className={selectClass}
            >
              {EDITORS.map((ed) => (
                <option key={ed.id} value={ed.id}>{ed.label}</option>
              ))}
            </select>
            <Chevron />
          </div>
        }
      />

      <Divider />

      <Row
        label="Open reviews in"
        hint="Where ⌘K opens a picked review."
        control={
          <div className="relative">
            <select
              aria-label="Open reviews in"
              value={openMode}
              onChange={(e) => setOpenMode(e.target.value as PickerOpenMode)}
              className={selectClass}
            >
              <option value="new-window">New window</option>
              <option value="replace">Current window</option>
            </select>
            <Chevron />
          </div>
        }
      />

      <Divider />

      <Row
        label="New window per branch"
        hint="Off: another branch of the same folder reuses its window."
        control={
          <OnOffToggle
            label="New window per branch"
            value={windowPerBranch ? "on" : "off"}
            onChange={(v) => setWindowPerBranch(v === "on")}
            onTitle="Each branch gets its own window"
            offTitle="One window per folder"
          />
        }
      />

      <Divider />

      <Row
        label="Detect changes"
        hint="Re-diff in the background when files change."
        control={
          <OnOffToggle
            label="Detect changes"
            value={changeDetection}
            onChange={setChangeDetection}
            onTitle="Offer Refresh when files change"
            offTitle="Refresh manually only"
          />
        }
      />

      <Divider />

      <Row
        label="Unviewed-only totals"
        hint="The file panel's +/− counter skips files you marked viewed."
        control={
          <OnOffToggle
            label="Unviewed-only totals"
            value={excludeViewed}
            onChange={setExcludeViewed}
            onTitle="Count only files not yet viewed"
            offTitle="Count every file"
          />
        }
      />

      <Divider />

      <Row
        label="Check for updates"
        hint="Look for a new version on launch and every few hours while open."
        control={
          <OnOffToggle
            label="Check for updates"
            value={updateCheck}
            onChange={setUpdateCheck}
            onTitle="Check on launch and periodically"
            offTitle="Never check for updates"
          />
        }
      />

      <Divider />

      <Row
        label="Download updates automatically"
        hint="Download a found update in the background; just restart to apply."
        control={
          <OnOffToggle
            label="Download updates automatically"
            value={autoDownload}
            onChange={setAutoDownload}
            onTitle="Download as soon as an update is found"
            offTitle="Ask before downloading"
          />
        }
      />
    </div>
  );
}
