use crate::review::model::{AnchorSpan, Comment, CommentScope, Review, Side};
use std::collections::BTreeMap;

pub fn export_markdown(review: &Review) -> String {
    let mut out = String::new();
    let t = &review.target;
    let worktree = t.worktree.as_deref().unwrap_or("");
    out.push_str(&format!(
        "# Review — {} · {} · {}\n",
        t.repo_path,
        worktree,
        t.mode.as_str()
    ));
    let head = review
        .snapshot
        .head_oid
        .as_deref()
        .unwrap_or("working tree");
    out.push_str(&format!(
        "Base {} ⇢ head {} · captured {}\n\n",
        review.snapshot.base_oid, head, review.snapshot.captured_at
    ));

    // General first.
    let generals: Vec<&Comment> = review
        .comments
        .iter()
        .filter(|c| c.scope == CommentScope::General && !c.resolved)
        .collect();
    if !generals.is_empty() {
        out.push_str("## General\n");
        for c in generals {
            out.push_str(&format!("- {}{}\n", stale_tag(c), c.body.trim()));
        }
        out.push('\n');
    }

    // Group the rest by file, preserving anchored line order.
    let mut by_file: BTreeMap<String, Vec<&Comment>> = BTreeMap::new();
    for c in review
        .comments
        .iter()
        .filter(|c| c.scope != CommentScope::General && !c.resolved)
    {
        if let Some(a) = &c.anchor {
            by_file.entry(a.file.clone()).or_default().push(c);
        }
    }
    for (file, mut comments) in by_file {
        // Point comments carry no line, so they'd all sit at key 0 — order them
        // by their y fraction as a tiebreak so the list reads top-to-bottom
        // like the image it annotates.
        comments.sort_by(|a, b| {
            let key = |c: &Comment| {
                let a = c.anchor.as_ref();
                let line = a
                    .and_then(|a| a.spans().iter().map(|s| (s.side == Side::Old, s.start)).min())
                    .map(|(_, start)| start)
                    .unwrap_or(0);
                let y = (a.and_then(|a| a.y).unwrap_or(0.0) * 1000.0) as u32;
                (line, y)
            };
            key(a).cmp(&key(b))
        });
        out.push_str(&format!("## {file}\n\n"));
        let lang = match file.rsplit_once('.') {
            Some((_, ext)) if !ext.contains('/') => ext,
            _ => "",
        };
        for c in comments {
            let a = c.anchor.as_ref().unwrap();
            let spans = a.spans();
            let (current, deleted) = spans
                .iter()
                .partition::<Vec<_>, _>(|s: &&AnchorSpan| s.side == Side::New);
            let listed = |group: &[&AnchorSpan]| {
                group
                    .iter()
                    .map(|s| {
                        if s.start == s.end {
                            s.start.to_string()
                        } else {
                            format!("{}–{}", s.start, s.end)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let header = match c.scope {
                CommentScope::File => "#### File-level".to_string(),
                CommentScope::Point => match (a.x, a.y) {
                    (Some(x), Some(y)) => format!(
                        "#### Image point (x {}% · y {}%)",
                        (x * 100.0).round() as u32,
                        (y * 100.0).round() as u32
                    ),
                    _ => "#### Image point".to_string(),
                },
                _ if spans.is_empty() => "#### File-level".to_string(),
                _ if current.is_empty() => format!("#### L{}", listed(&deleted)),
                _ if deleted.is_empty() => format!("#### L{}", listed(&current)),
                _ => format!(
                    "#### L{} · deleted: old side {}",
                    listed(&current),
                    listed(&deleted)
                ),
            };
            let side_note = if a.side == Side::Old {
                " · old-side"
            } else {
                ""
            };
            let commit_note = match &c.commit {
                Some(oid) => format!(" · commit {}", oid.chars().take(7).collect::<String>()),
                None => String::new(),
            };
            out.push_str(&format!(
                "{header}{side_note}{commit_note}{}\n",
                stale_suffix(c)
            ));
            let text_of = |group: &[&AnchorSpan]| {
                group
                    .iter()
                    .map(|s| s.text.trim_end())
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let fence = |text: &str| format!("```{lang}\n{text}\n```");
            let split = !current.is_empty() && !deleted.is_empty();
            let snippet = if split {
                let part = |label: String, text: String| {
                    (!text.trim().is_empty()).then(|| format!("{label}\n{}", fence(&text)))
                };
                [
                    part(
                        format!("deleted (old side {}):", listed(&deleted)),
                        text_of(&deleted),
                    ),
                    part(format!("current ({}):", listed(&current)), text_of(&current)),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n\n")
            } else if spans.is_empty() {
                String::new()
            } else {
                fence(&text_of(if current.is_empty() { &deleted } else { &current }))
            };
            if !snippet.is_empty() {
                if split {
                    out.push('\n');
                }
                out.push_str(&snippet);
                out.push('\n');
                if split {
                    out.push('\n');
                }
            }
            out.push_str(&format!("{}\n\n", c.body.trim()));
        }
    }

    out
}

fn stale_tag(c: &Comment) -> &'static str {
    if c.stale {
        "⚠ stale — "
    } else {
        ""
    }
}

fn stale_suffix(c: &Comment) -> &'static str {
    if c.stale {
        " · ⚠ stale"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Anchor, AnchorSpan, CommentScope, Side, Snapshot};

    fn review_with(comments: Vec<Comment>) -> Review {
        let target = Target {
            repo_path: "/r".into(),
            worktree: Some("feat/auth".into()),
            mode: DiffMode::BranchVsBase,
            base: Some("main".into()),
            commit: None,
        };
        let mut r = Review::new(
            "id".into(),
            target,
            Snapshot {
                base_oid: "a1b2c3d".into(),
                head_oid: Some("e4f5g6h".into()),
                head_commit: None,
                captured_at: "2026-06-25T18:54:00Z".into(),
            },
            "t".into(),
        );
        r.comments = comments;
        r
    }

    fn cmt(
        scope: CommentScope,
        anchor: Option<Anchor>,
        body: &str,
        stale: bool,
        resolved: bool,
    ) -> Comment {
        Comment {
            id: "x".into(),
            scope,
            anchor,
            body: body.into(),
            stale,
            resolved,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn general_section_comes_first() {
        let md = export_markdown(&review_with(vec![
            cmt(
                CommentScope::Line,
                Some(Anchor {
                    file: "src/a.ts".into(),
                    side: Side::New,
                    start_line: Some(40),
                    end_line: None,
                    snippet: Some("export const TTL = 3600".into()),
                    x: None,
                    y: None,
                    spans: None,
                }),
                "make configurable",
                false,
                false,
            ),
            cmt(
                CommentScope::General,
                None,
                "standardize errors",
                false,
                false,
            ),
        ]));
        let general_pos = md.find("## General").unwrap();
        let file_pos = md.find("## src/a.ts").unwrap();
        assert!(general_pos < file_pos, "General must precede file sections");
        assert!(md.contains("standardize errors"));
    }

    #[test]
    fn line_comment_has_location_snippet_and_body() {
        let md = export_markdown(&review_with(vec![cmt(
            CommentScope::Line,
            Some(Anchor {
                file: "src/a.ts".into(),
                side: Side::New,
                start_line: Some(40),
                end_line: None,
                snippet: Some("export const TTL = 3600".into()),
                x: None,
                y: None,
                spans: None,
            }),
            "make configurable",
            false,
            false,
        )]));
        assert!(md.contains("#### L40"));
        assert!(md.contains("```ts"));
        assert!(md.contains("export const TTL = 3600"));
        assert!(md.contains("make configurable"));
    }

    #[test]
    fn point_comment_renders_image_position_and_orders_top_to_bottom() {
        let at = |x: f64, y: f64| {
            cmt(
                CommentScope::Point,
                Some(Anchor {
                    file: "assets/logo.png".into(),
                    side: Side::New,
                    start_line: None,
                    end_line: None,
                    snippet: None,
                    x: Some(x),
                    y: Some(y),
                    spans: None,
                }),
                &format!("note at y{y}"),
                false,
                false,
            )
        };
        let md = export_markdown(&review_with(vec![at(0.2, 0.8), at(0.3, 0.62)]));
        assert!(md.contains("#### Image point (x 30% · y 62%)"));
        assert!(md.contains("note at y0.62"));
        // Top-to-bottom: the y=0.62 note renders before the y=0.8 one.
        let a = md.find("note at y0.62").unwrap();
        let b = md.find("note at y0.8").unwrap();
        assert!(a < b);
    }

    #[test]
    fn stale_is_marked_not_dropped() {
        let md = export_markdown(&review_with(vec![cmt(
            CommentScope::Line,
            Some(Anchor {
                file: "src/a.ts".into(),
                side: Side::Old,
                start_line: Some(8),
                end_line: None,
                snippet: Some("if (!token) return null".into()),
                x: None,
                y: None,
                spans: None,
            }),
            "redundant guard",
            true,
            false,
        )]));
        assert!(md.contains("⚠ stale"));
        assert!(md.contains("redundant guard"));
        assert!(md.contains("old-side"));
    }

    fn span(side: Side, start: u32, end: u32, text: &str) -> AnchorSpan {
        AnchorSpan { side, start, end, text: text.into() }
    }

    #[test]
    fn every_selected_run_is_listed_in_the_header_and_the_snippet() {
        let comment = cmt(
            CommentScope::Range,
            Some(Anchor {
                file: "src/a.ts".into(),
                side: Side::New,
                start_line: None,
                end_line: None,
                snippet: None,
                x: None,
                y: None,
                spans: Some(vec![span(Side::New, 3, 5, "a\nb\nc"), span(Side::New, 10, 10, "j")]),
            }),
            "split these",
            false,
            false,
        );
        let md = export_markdown(&review_with(vec![comment]));
        assert!(
            md.contains("#### L3–5, 10\n```ts\na\nb\nc\nj\n```\nsplit these"),
            "{md}"
        );
    }

    #[test]
    fn deleted_lines_get_their_own_block() {
        let comment = cmt(
            CommentScope::Range,
            Some(Anchor {
                file: "src/a.ts".into(),
                side: Side::New,
                start_line: None,
                end_line: None,
                snippet: None,
                x: None,
                y: None,
                spans: Some(vec![
                    span(Side::New, 10, 12, "j\nk\nl"),
                    span(Side::New, 20, 20, "t"),
                    span(Side::Old, 8, 9, "h\ni"),
                ]),
            }),
            "rethink",
            false,
            false,
        );
        let md = export_markdown(&review_with(vec![comment]));
        assert!(
            md.contains(
                "#### L10–12, 20 · deleted: old side 8–9\n\ndeleted (old side 8–9):\n```ts\nh\ni\n```\n\ncurrent (10–12, 20):\n```ts\nj\nk\nl\nt\n```\n\nrethink"
            ),
            "{md}"
        );
    }

    #[test]
    fn resolved_comments_are_excluded() {
        let md = export_markdown(&review_with(vec![
            cmt(
                CommentScope::Line,
                Some(Anchor {
                    file: "src/a.ts".into(),
                    side: Side::New,
                    start_line: Some(40),
                    end_line: None,
                    snippet: Some("keep".into()),
                    x: None,
                    y: None,
                    spans: None,
                }),
                "keep me",
                false,
                false,
            ),
            cmt(
                CommentScope::Line,
                Some(Anchor {
                    file: "src/a.ts".into(),
                    side: Side::New,
                    start_line: Some(41),
                    end_line: None,
                    snippet: Some("gone".into()),
                    x: None,
                    y: None,
                    spans: None,
                }),
                "resolved away",
                false,
                true,
            ),
        ]));
        assert!(md.contains("keep me"));
        assert!(!md.contains("resolved away"));
    }

    #[test]
    fn commit_tag_is_rendered() {
        let mut c = cmt(
            CommentScope::Line,
            Some(Anchor {
                file: "src/a.ts".into(),
                side: Side::New,
                start_line: Some(40),
                end_line: None,
                snippet: Some("export const TTL = 3600".into()),
                x: None,
                y: None,
                spans: None,
            }),
            "make configurable",
            false,
            false,
        );
        c.commit = Some("a1b2c3d4e5f6a7b8c9d0".into());
        let md = export_markdown(&review_with(vec![c]));
        assert!(
            md.contains("commit a1b2c3d"),
            "expected short commit marker, got:\n{md}"
        );
    }
}
