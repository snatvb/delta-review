use crate::git::model::Target;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentScope {
    Line,
    Range,
    File,
    /// A point on a binary image, anchored by fractions in `Anchor::x`/`y`.
    Point,
    General,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    New,
    Old,
}

/// A run of consecutive commented lines on one side of the diff. A context
/// line is always anchored to the new side, so an old-side span is a deleted line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorSpan {
    pub side: Side,
    pub start: u32,
    pub end: u32,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub file: String,
    pub side: Side,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Image point anchor (scope `point`): position as fractions 0..1 of that
    /// side's natural dimensions — stable across preview scaling and zoom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    /// Absent on anchors stored before `spans` existed, which hold a single run
    /// in `start_line`/`end_line`/`snippet`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<AnchorSpan>>,
}

impl Anchor {
    pub fn spans(&self) -> Vec<AnchorSpan> {
        match (&self.spans, self.start_line) {
            (Some(spans), _) => spans.clone(),
            (None, Some(start)) => vec![AnchorSpan {
                side: self.side,
                start,
                end: self.end_line.unwrap_or(start).max(start),
                text: self.snippet.clone().unwrap_or_default(),
            }],
            (None, None) => Vec::new(),
        }
    }

    pub fn set_spans(&mut self, spans: Vec<AnchorSpan>) {
        self.spans = Some(spans);
        self.project();
    }

    /// Older app versions read only `side`/`start_line`/`end_line`/`snippet`,
    /// so keep them describing the same lines.
    pub fn project(&mut self) {
        let projected = self.spans.as_ref().map(|spans| {
            let (current, deleted): (Vec<&AnchorSpan>, Vec<&AnchorSpan>) =
                spans.iter().partition(|s| s.side == Side::New);
            let leads = if current.is_empty() { &deleted } else { &current };
            let start = leads.iter().map(|s| s.start).min();
            let end = leads.iter().map(|s| s.end).max().filter(|end| Some(*end) != start);
            let text = current
                .iter()
                .chain(deleted.iter())
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            (if current.is_empty() { Side::Old } else { Side::New }, start, end, (!text.is_empty()).then_some(text))
        });
        if let Some((side, start, end, text)) = projected {
            self.side = side;
            self.start_line = start;
            self.end_line = end;
            self.snippet = text;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub scope: CommentScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    pub body: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub base_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    /// Branch HEAD commit at capture time — how reconcile detects "new commits
    /// landed" so untagged comments can be handed off to the commit that took
    /// their file. Stamped on every reconcile; `None` only for pre-field data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewedEntry {
    pub file: String,
    pub diff_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub version: u32,
    pub id: String,
    pub target: Target,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub viewed: Vec<ViewedEntry>,
    pub created_at: String,
    pub last_opened_at: String,
}

impl Review {
    pub fn new(id: String, target: Target, snapshot: Snapshot, now: String) -> Self {
        Review {
            version: 2,
            id,
            target,
            snapshot,
            comments: Vec::new(),
            viewed: Vec::new(),
            created_at: now.clone(),
            last_opened_at: now,
        }
    }
}

/// Stable review id: first 16 hex chars of SHA-256(repoPath \0 worktree).
/// Mode is intentionally excluded — one review per (repo, worktree).
pub fn review_id(repo_path: &str, worktree: &str) -> String {
    let mut h = Sha256::new();
    h.update(repo_path.as_bytes());
    h.update([0]);
    h.update(worktree.as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_id_is_stable_and_mode_independent() {
        let a = review_id("/Users/me/p", "main");
        let b = review_id("/Users/me/p", "main");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // worktree participates; mode is no longer part of the id (no arg).
        assert_ne!(a, review_id("/Users/me/p", "feat"));
    }

    #[test]
    fn scope_and_side_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&CommentScope::Range).unwrap(),
            "\"range\""
        );
        assert_eq!(serde_json::to_string(&Side::New).unwrap(), "\"new\"");
    }

    #[test]
    fn comment_resolved_defaults_false_and_serializes() {
        // Legacy JSON without `resolved` must deserialize (→ false).
        let json =
            r#"{"id":"c","scope":"line","body":"b","stale":false,"createdAt":"t","updatedAt":"t"}"#;
        let c: Comment = serde_json::from_str(json).unwrap();
        assert!(!c.resolved);
        // And it is always written back out.
        let out = serde_json::to_string(&c).unwrap();
        assert!(out.contains("\"resolved\":false"));
    }

    #[test]
    fn point_anchor_round_trips_and_legacy_json_lacks_xy() {
        let json = r#"{"id":"c","scope":"point","anchor":{"file":"a.png","side":"new","x":0.25,"y":0.75},"body":"b","stale":false,"resolved":false,"createdAt":"t","updatedAt":"t"}"#;
        let c: Comment = serde_json::from_str(json).unwrap();
        assert_eq!(c.scope, CommentScope::Point);
        let a = c.anchor.unwrap();
        assert_eq!(a.x, Some(0.25));
        assert_eq!(a.y, Some(0.75));
        // Legacy anchors without x/y still deserialize (→ None) and don't grow
        // the fields back on save (skip_serializing_if).
        let legacy: Comment = serde_json::from_str(
            r#"{"id":"c","scope":"line","anchor":{"file":"a.ts","side":"new","startLine":3},"body":"b","stale":false,"resolved":false,"createdAt":"t","updatedAt":"t"}"#,
        )
        .unwrap();
        assert!(legacy.anchor.as_ref().unwrap().x.is_none());
        assert!(!serde_json::to_string(&legacy).unwrap().contains("\"x\""));
    }

    #[test]
    fn an_anchor_stored_before_spans_reads_as_one_run() {
        let legacy: Anchor = serde_json::from_str(
            r#"{"file":"a.ts","side":"new","startLine":3,"endLine":5,"snippet":"a\nb\nc"}"#,
        )
        .unwrap();
        assert_eq!(
            legacy.spans(),
            vec![AnchorSpan { side: Side::New, start: 3, end: 5, text: "a\nb\nc".into() }]
        );
        let single: Anchor =
            serde_json::from_str(r#"{"file":"a.ts","side":"old","startLine":8}"#).unwrap();
        assert_eq!(
            single.spans(),
            vec![AnchorSpan { side: Side::Old, start: 8, end: 8, text: String::new() }]
        );
    }

    #[test]
    fn spans_round_trip_and_project_the_fields_older_versions_read() {
        let json = r#"{"file":"a.ts","side":"new","spans":[{"side":"new","start":10,"end":12,"text":"j\nk\nl"},{"side":"new","start":20,"end":20,"text":"t"},{"side":"old","start":8,"end":9,"text":"h\ni"}]}"#;
        let mut anchor: Anchor = serde_json::from_str(json).unwrap();
        assert_eq!(anchor.spans().len(), 3);

        anchor.project();
        let out: serde_json::Value = serde_json::to_value(&anchor).unwrap();
        assert_eq!(out["side"], "new");
        assert_eq!(out["startLine"], 10);
        assert_eq!(out["endLine"], 20);
        assert_eq!(out["snippet"], "j\nk\nl\nt\nh\ni");
        assert_eq!(out["spans"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn an_old_side_only_selection_projects_a_single_line_span_without_an_end() {
        let mut anchor = Anchor {
            file: "a.ts".into(),
            side: Side::New,
            start_line: None,
            end_line: None,
            snippet: None,
            x: None,
            y: None,
            spans: None,
        };
        anchor.set_spans(vec![AnchorSpan { side: Side::Old, start: 8, end: 8, text: "h".into() }]);
        assert_eq!(anchor.side, Side::Old);
        assert_eq!(anchor.start_line, Some(8));
        assert_eq!(anchor.end_line, None);
        assert_eq!(anchor.snippet.as_deref(), Some("h"));
    }
}
