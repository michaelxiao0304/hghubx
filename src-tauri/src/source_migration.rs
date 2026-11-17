//! One-time import of the 1.3 fork's source.json into upstream line.json.
//! Keep source.json untouched as a recovery copy; never overwrite an existing line.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn migrate(dir: &Path) -> Result<bool, String> {
    let destination = dir.join("line.json");
    if destination.exists() { return Ok(false); }
    let raw = match fs::read_to_string(dir.join("source.json")) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("旧接入配置读取失败，原文件已保留".into()),
    };
    let source: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "旧接入配置格式无效，原文件已保留")?;
    let base = source.get("base").and_then(serde_json::Value::as_str)
        .and_then(crate::net::normalize_base)
        .ok_or("旧接入地址不符合 HTTPS 根地址要求，原文件已保留")?;
    if source.get("adapter").and_then(serde_json::Value::as_str)
        .is_some_and(|adapter| adapter != "edge_v1") {
        return Err("旧接入配置的适配器不兼容，原文件已保留".into());
    }
    // This was an explicitly configured origin in 1.3, not an untrusted mirror
    // discovered from a file. Credentials still remain bound to their own origin.
    let bytes = serde_json::to_vec(&serde_json::json!({
        "v": 2, "base": base, "custom": !crate::lines::is_fixed(&base),
    })).map_err(|_| "旧接入配置转换失败")?;
    let temp = dir.join(format!(".line-migration-{}-{}.tmp", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> std::io::Result<bool> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Publish the complete file atomically without replacing an existing
        // destination, including a line saved by another app instance.
        match fs::hard_link(&temp, &destination) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(&temp);
    result.map_err(|_| "接入配置迁移写入失败，旧配置已保留供下次重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let serial = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("hghubx-source-migration-{}-{stamp}-{serial}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn imports_explicit_source_and_keeps_original_without_overwriting_new_choices() {
        let dir = Directory::new();
        let original = r#"{"base":"https://mirror.fixture.invalid/","adapter":"edge_v1"}"#;
        fs::write(dir.0.join("source.json"), original).unwrap();
        assert!(migrate(&dir.0).unwrap());
        let line: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.0.join("line.json")).unwrap()).unwrap();
        assert_eq!(line, serde_json::json!({"v":2,"base":"https://mirror.fixture.invalid","custom":true}));
        assert_eq!(fs::read_to_string(dir.0.join("source.json")).unwrap(), original);
        let changed = r#"{"v":2,"base":"https://chosen.fixture.invalid","custom":true}"#;
        fs::write(dir.0.join("line.json"), changed).unwrap();
        assert!(!migrate(&dir.0).unwrap());
        assert_eq!(fs::read_to_string(dir.0.join("line.json")).unwrap(), changed);
    }

    #[test]
    fn rejects_invalid_sources_without_deleting_or_trusting_them() {
        let dir = Directory::new();
        assert!(!migrate(&dir.0).unwrap());
        for base in ["", "not a url", "http://mirror.fixture.invalid", "https://127.0.0.1", "https://mirror.fixture.invalid/path", "https://user:secret@mirror.fixture.invalid"] {
            let original = serde_json::json!({"base":base}).to_string();
            fs::write(dir.0.join("source.json"), &original).unwrap();
            assert!(migrate(&dir.0).is_err(), "{base}");
            assert!(!dir.0.join("line.json").exists());
            assert_eq!(fs::read_to_string(dir.0.join("source.json")).unwrap(), original);
        }
        fs::write(dir.0.join("source.json"), "invalid json").unwrap();
        assert!(migrate(&dir.0).is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn preserves_existing_line_even_when_legacy_source_is_broken() {
        let dir = Directory::new();
        let existing = r#"{"base":"https://huangguoai.com"}"#;
        fs::write(dir.0.join("line.json"), existing).unwrap();
        fs::write(dir.0.join("source.json"), "broken").unwrap();
        assert!(!migrate(&dir.0).unwrap());
        assert_eq!(fs::read_to_string(dir.0.join("line.json")).unwrap(), existing);
    }
}
