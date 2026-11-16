#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let complete = self.pending.len() - incomplete_tail_len(&self.pending);
        let tail = self.pending.split_off(complete);
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending = tail;
        text
    }

    pub fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

fn sequence_len(lead: u8) -> usize {
    match lead {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

fn is_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

fn incomplete_tail_len(bytes: &[u8]) -> usize {
    let max_back = bytes.len().min(3);
    for back in 1..=max_back {
        let byte = bytes[bytes.len() - back];
        if is_continuation(byte) {
            continue;
        }
        return if sequence_len(byte) > back { back } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passes_straight_through() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"hello"), "hello");
        assert_eq!(s.finish(), "");
    }

    #[test]
    fn multibyte_char_split_across_chunks_is_stitched() {
        let bytes = "жёлтый ✓ 🦀".as_bytes();
        for cut in 0..=bytes.len() {
            let mut s = Utf8Stream::default();
            let mut out = s.push(&bytes[..cut]);
            out.push_str(&s.push(&bytes[cut..]));
            out.push_str(&s.finish());
            assert_eq!(out, "жёлтый ✓ 🦀", "cut at {cut}");
        }
    }

    #[test]
    fn byte_by_byte_feed_keeps_every_char() {
        let text = "a🦀b";
        let mut s = Utf8Stream::default();
        let out: String = text.as_bytes().iter().map(|b| s.push(&[*b])).collect();
        assert_eq!(out, text);
    }

    #[test]
    fn invalid_bytes_become_replacement_chars() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn dangling_lead_byte_is_flushed_on_finish() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(&[b'x', 0xE2, 0x9C]), "x");
        assert_eq!(s.finish(), "\u{FFFD}");
    }
}
