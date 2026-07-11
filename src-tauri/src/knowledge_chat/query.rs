pub fn decompose_query(query: &str) -> Vec<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let lower = trimmed.to_lowercase();
    let mut parts = Vec::new();

    for delimiter in [" vs ", " versus ", " compare ", " and also ", " as well as "] {
        if lower.contains(delimiter.trim()) {
            for piece in trimmed.split(delimiter) {
                push_unique(&mut parts, piece.trim());
            }
            if parts.len() > 1 {
                return parts;
            }
            parts.clear();
        }
    }

    if trimmed.contains('?') && trimmed.matches('?').count() > 1 {
        for piece in trimmed.split('?') {
            let q = piece.trim();
            if q.len() > 8 {
                push_unique(&mut parts, &format!("{q}?"));
            }
        }
        if parts.len() > 1 {
            return parts;
        }
        parts.clear();
    }

    if trimmed.contains(';') {
        for piece in trimmed.split(';') {
            push_unique(&mut parts, piece.trim());
        }
        if parts.len() > 1 {
            return parts;
        }
    }

    vec![trimmed.to_string()]
}

fn push_unique(out: &mut Vec<String>, value: &str) {
    if value.len() < 4 {
        return;
    }
    if out.iter().any(|existing| existing.eq_ignore_ascii_case(value)) {
        return;
    }
    out.push(value.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_compare_queries() {
        let parts = decompose_query("Compare MFA policy vs VPN policy");
        assert!(parts.len() >= 2);
    }
}
