//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// A permission denial must not invalidate an otherwise usable login.
pub fn http_auth_error(status: u16) -> Option<&'static str> {
    match status {
        401 => Some("401"),
        403 => Some("HTTP 403 Forbidden"),
        _ => None,
    }
}

/// Credential trust for session rebase: fixed line or a mirror confirmed by a
/// trusted publish page in this process. Custom lines are deliberately NOT
/// trusted here — an explicitly saved custom origin may carry its own login,
/// but a token must never follow a switch to or from it.
pub fn rebase_trust(origin: &str) -> bool {
    crate::lines::is_fixed(origin) || crate::lines::is_trusted_mirror(origin)
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
    /// First origin of this login's verified line changes, used only to locate its local library.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_origin: Option<String>,
    /// Process-local identity epoch, so even logout/login with a reused token invalidates old work.
    #[serde(skip)]
    pub revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 1}),
        );
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.user("https://evil.example").is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.user("https://huangguoai.com").is_null());
    }

    #[test]
    fn late_profile_and_logout_cannot_replace_a_new_session() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        store.set(origin, "first".into(), json!({"id": 1}));
        let first = store.snapshot(origin).unwrap();
        store.set(origin, "second".into(), json!({"id": 2}));
        assert!(!store.update_user_if_current(&first, json!({"id": 1, "nickname": "late"})));
        assert!(!store.clear_if_current(&first).unwrap());
        assert_eq!(store.user(origin)["id"], 2);
        let second = store.snapshot(origin).unwrap();
        assert!(!store.update_user_if_current(&second, json!({"id": 1})));
        assert!(store.update_user_if_current(&second, json!({"id": 2, "nickname": "fresh"})));
    }

    #[test]
    fn relogin_with_same_token_still_invalidates_old_requests() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        store.set(origin, "same".into(), json!({"id": 1}));
        let old = store.snapshot(origin).unwrap();
        store.clear();
        store.set(origin, "same".into(), json!({"id": 1}));
        assert!(!store.is_current(&old));
        assert!(!store.clear_if_current(&old).unwrap());
        assert!(serde_json::to_value(store.snapshot(origin).unwrap()).unwrap().get("revision").is_none());
    }

    #[test]
    fn late_login_cannot_replace_a_newer_account() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        let revision = store.revision();
        assert!(store.set_if_revision(revision, origin, "new".into(), json!({"id": 2})).is_err());
        assert!(store.token(origin).is_none());
        let dir = std::env::temp_dir().join(format!("hghubx-login-revision-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        store.bind(dir.clone());
        assert!(store.set_if_revision(revision, origin, "new".into(), json!({"id": 2})).unwrap());
        assert!(!store.set_if_revision(revision, origin, "late".into(), json!({"id": 1})).unwrap());
        assert_eq!(store.user(origin)["id"], 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    // Trusted rebase tests parameterize the trust predicate (like the real
    // callers inject `lines::is_fixed || lines::is_trusted_mirror`), so they do
    // not depend on which fixed lines exist or on the process-global mirror set.
    fn trusted_pair(origin: &str) -> bool {
        matches!(origin, "https://huangguoai.com" | "https://mirror-a.example")
    }

    #[test]
    fn trusted_rebase_moves_session_and_bumps_revision() {
        let store = SessionStore::new();
        let old_origin = "https://huangguoai.com";
        let new_origin = "https://mirror-a.example";
        store.set(old_origin, "secret-token".into(), json!({"id": 1}));
        let before = store.snapshot(old_origin).unwrap();
        assert!(store.rebase_if_trusted(new_origin, trusted_pair));
        assert_eq!(store.token(new_origin).as_deref(), Some("secret-token"));
        assert_eq!(store.user(new_origin)["id"], 1);
        // The old origin no longer resolves credentials.
        assert_eq!(store.token(old_origin), None);
        assert!(store.user(old_origin).is_null());
        // Same set_if_revision semantics: pre-switch snapshots are stale.
        assert_eq!(store.revision(), before.revision.wrapping_add(1));
        assert!(!store.is_current(&before));
        assert!(!store.update_user_if_current(&before, json!({"id": 1, "nickname": "late"})));
        assert!(!store.clear_if_current(&before).unwrap());
        assert_eq!(store.stored_origin().as_deref(), Some(new_origin));
    }

    #[test]
    fn trusted_rebase_persists_the_new_origin() {
        let dir = std::env::temp_dir().join(format!(
            "hghubx-session-rebase-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SessionStore::new();
        store.bind(dir.clone());
        store.set("https://huangguoai.com", "secret-token".into(), json!({"id": 1}));
        assert!(store.rebase_if_trusted("https://mirror-a.example", trusted_pair));
        let on_disk: Session =
            serde_json::from_str(&std::fs::read_to_string(dir.join("session.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk.origin, "https://mirror-a.example");
        assert_eq!(on_disk.token, "secret-token");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rebase_refuses_untrusted_endpoints_in_both_directions() {
        for (old_origin, new_origin) in [
            // Trusted -> custom/untrusted must not hand the token over.
            ("https://huangguoai.com", "https://custom.example"),
            // Custom/untrusted -> trusted must not smuggle credentials in either.
            ("https://custom.example", "https://huangguoai.com"),
            // Unknown mirror -> trusted mirror.
            ("https://unpublished.example", "https://mirror-a.example"),
        ] {
            let store = SessionStore::new();
            store.set(old_origin, "secret-token".into(), json!({"id": 1}));
            let before = store.snapshot(old_origin).unwrap();
            assert!(!store.rebase_if_trusted(new_origin, trusted_pair), "{old_origin} -> {new_origin}");
            // Session untouched: same origin, token, identity epoch.
            assert_eq!(store.token(old_origin).as_deref(), Some("secret-token"));
            assert_eq!(store.token(new_origin), None);
            assert!(store.is_current(&before));
            assert_eq!(store.revision(), before.revision);
        }
    }

    #[test]
    fn rebase_on_empty_session_is_a_noop() {
        let store = SessionStore::new();
        assert_eq!(store.stored_origin(), None);
        let revision = store.revision();
        assert!(!store.rebase_if_trusted("https://mirror-a.example", trusted_pair));
        assert_eq!(store.revision(), revision);
        // Legacy sessions without origin stay unassigned and cannot be rebased.
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.stored_origin(), None);
        assert!(!store.rebase_if_trusted("https://huangguoai.com", trusted_pair));
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn rebase_to_the_same_origin_keeps_the_revision() {
        let store = SessionStore::new();
        let origin = "https://huangguoai.com";
        store.set(origin, "secret-token".into(), json!({"id": 1}));
        let before = store.snapshot(origin).unwrap();
        assert!(store.rebase_if_trusted(origin, trusted_pair));
        assert!(store.is_current(&before));
        assert_eq!(store.revision(), before.revision);
    }

    #[test]
    fn line_change_keeps_trusted_and_drops_custom() {
        let store = SessionStore::new();
        store.set("https://huangguoai.com", "secret-token".into(), json!({"id": 1}));
        store.line_changed("https://mirror-a.example", false, trusted_pair);
        assert_eq!(store.token("https://mirror-a.example").as_deref(), Some("secret-token"));
        // Untrusted target: the session is dropped, never handed over.
        store.line_changed("https://custom.example", true, trusted_pair);
        assert_eq!(store.token("https://mirror-a.example"), None);
        assert_eq!(store.token("https://custom.example"), None);
        assert!(store.stored_origin().is_none());
    }

    #[tokio::test]
    async fn boot_reconcile_verifies_stored_mirror_even_when_current_line_is_fixed() {
        let dir = std::env::temp_dir().join(format!("hghubx-session-restart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let previous = SessionStore::new();
        previous.bind(dir.clone());
        previous.set("https://mirror-a.example", "secret-token".into(), json!({"id": 1}));
        // An overlay update opens the same data directory with empty process-local mirror trust.
        let store = SessionStore::new();
        store.bind(dir.clone());
        let before_switch = store.snapshot("https://mirror-a.example").unwrap();
        let main = "https://huangguoai.com";
        store.line_changed(main, false, |origin| origin == main);
        assert_eq!(store.stored_origin().as_deref(), Some("https://mirror-a.example"));
        assert!(store.token(main).is_none());
        assert!(!store.is_current(&before_switch));
        store.reconcile_with(main, || main.into(), |origin| origin == main, |_| std::future::ready(())).await;
        let reopened = SessionStore::new();
        reopened.bind(dir.clone());
        assert_eq!(reopened.stored_origin(), store.stored_origin());
        assert!(reopened.token(main).is_none());
        let pending = reopened.boot_session(main, true, false);
        assert_eq!(pending["pending_session"], json!({"origin":"https://mirror-a.example","user":{"id":1}}));
        assert_eq!(pending["logged_in"], false);
        assert!(pending["user"].is_null());
        let published = std::sync::Mutex::new(Vec::<String>::new());
        store
            .reconcile_with(
                "https://huangguoai.com",
                || "https://huangguoai.com".to_string(),
                |origin| {
                    origin == "https://huangguoai.com"
                        || published.lock().unwrap().iter().any(|item| item == origin)
                },
                |origin| {
                    if origin != "https://huangguoai.com" {
                        published.lock().unwrap().push("https://mirror-a.example".into());
                    }
                    std::future::ready(())
                },
            )
            .await;
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        let active = store.boot_session(main, true, false);
        assert_eq!(active["library_origin"], "https://mirror-a.example");
        assert!(active["pending_session"].is_null());
        assert_eq!(active["user"]["id"], 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

pub struct SessionStore {
    pub file: Mutex<Option<PathBuf>>,
    pub current: Mutex<Session>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            current: Mutex::new(Session::default()),
        }
    }

    pub fn bind(&self, dir: PathBuf) {
        let mut path = dir;
        path.push("session.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(sess) = serde_json::from_str::<Session>(&text) {
                *self.current.lock().unwrap() = sess;
            }
        }
        *self.file.lock().unwrap() = Some(path);
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.token.clone())
    }

    #[cfg(test)]
    fn user(&self, origin: &str) -> serde_json::Value {
        let cur = self.current.lock().unwrap();
        if cur.origin == origin && !cur.token.is_empty() {
            cur.user.clone()
        } else {
            serde_json::Value::Null
        }
    }

    pub fn snapshot(&self, origin: &str) -> Option<Session> {
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.clone())
    }

    /// Origin of the stored session (if any), regardless of the current line.
    /// Boot uses this to decide whether a trusted rebase is worth attempting;
    /// it never exposes the token itself.
    pub fn stored_origin(&self) -> Option<String> {
        let cur = self.current.lock().unwrap();
        (!cur.token.is_empty() && !cur.origin.is_empty()).then(|| cur.origin.clone())
    }

    /// Returns only local profile data; transport authorization remains origin-bound.
    pub fn boot_session(&self, origin: &str, authorized: bool, custom: bool) -> serde_json::Value {
        let cur = self.current.lock().unwrap();
        let stored = !cur.token.is_empty() && !cur.origin.is_empty() && !cur.user.is_null();
        let active = stored && cur.origin == origin && authorized;
        let pending = stored && !active && !custom;
        serde_json::json!({
            "logged_in": active,
            "user": active.then_some(&cur.user),
            "library_origin": cur.library_origin.as_deref().filter(|_| active || pending),
            "pending_session": pending.then(|| serde_json::json!({ "origin": cur.origin, "user": cur.user })),
        })
    }

    /// Only a verified pair may move the token. The caller holds the session lock.
    fn rebase(cur: &mut Session, new_origin: &str, trusted: impl Fn(&str) -> bool) -> bool {
        if cur.token.is_empty() || cur.origin.is_empty() || !trusted(&cur.origin) || !trusted(new_origin) {
            return false;
        }
        if cur.origin != new_origin {
            cur.library_origin.get_or_insert_with(|| cur.origin.clone());
            cur.origin = new_origin.to_owned();
            cur.revision = cur.revision.wrapping_add(1);
        }
        true
    }

    #[cfg(test)]
    fn rebase_if_trusted(&self, new_origin: &str, trusted: impl Fn(&str) -> bool) -> bool {
        let ok = Self::rebase(&mut self.current.lock().unwrap(), new_origin, trusted);
        if ok { self.persist(); }
        ok
    }

    pub fn line_changed(&self, new_origin: &str, custom_boundary: bool, trusted: impl Fn(&str) -> bool) {
        if custom_boundary {
            self.clear();
            return;
        }
        let mut cur = self.current.lock().unwrap();
        let revision = cur.revision;
        let moved = Self::rebase(&mut cur, new_origin, trusted);
        // A pre-switch login or 401 is stale even while publisher verification is pending.
        cur.revision = revision.wrapping_add(1);
        drop(cur);
        if moved { self.persist(); }
    }

    pub async fn reconcile_on_boot(&self, origin: &str) {
        self.reconcile_with(
            origin,
            crate::net::base,
            rebase_trust,
            |target| async move {
                let _ = crate::lines::verify_published_origin(&target).await;
            },
        )
        .await;
    }

    async fn reconcile_with<Cur, Trust, Verify, Fut>(
        &self,
        origin: &str,
        current_base: Cur,
        trusted: Trust,
        mut verify: Verify,
    ) where
        Cur: Fn() -> String,
        Trust: Fn(&str) -> bool,
        Verify: FnMut(String) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let rev = self.revision();
        let stored = self.stored_origin();
        if self.token(origin).is_none() {
            if let Some(old) = stored.as_deref().filter(|old| *old != origin) {
                verify(old.to_owned()).await;
                verify(origin.to_owned()).await;
                let moved = {
                    let mut cur = self.current.lock().unwrap();
                    cur.revision == rev && current_base() == origin && Self::rebase(&mut cur, origin, trusted)
                };
                if moved { self.persist(); }
            }
        } else if crate::network_policy::strict_security() && !crate::net::trusted_auth_origin(origin) {
            verify(origin.to_owned()).await;
        }
    }

    pub fn revision(&self) -> u64 {
        self.current.lock().unwrap().revision
    }

    pub fn set_if_revision(&self, expected_revision: u64, origin: &str, token: String, user: serde_json::Value) -> Result<bool, String> {
        let mut cur = self.current.lock().unwrap();
        if cur.revision != expected_revision { return Ok(false); }
        let next = Session {
            origin: origin.to_owned(), token, user, library_origin: None,
            revision: cur.revision.wrapping_add(1),
        };
        self.save(&next).map_err(|_| "登录信息未能保存，请检查应用存储空间后重试")?;
        *cur = next;
        Ok(true)
    }

    fn same_identity(current: &Session, expected: &Session) -> bool {
        current.revision == expected.revision
            && current.origin == expected.origin
            && current.token == expected.token
            && current.user.get("id") == expected.user.get("id")
    }

    pub fn is_current(&self, expected: &Session) -> bool {
        Self::same_identity(&self.current.lock().unwrap(), expected)
    }

    pub fn update_user_if_current(&self, expected: &Session, user: serde_json::Value) -> bool {
        {
            let mut cur = self.current.lock().unwrap();
            if !Self::same_identity(&cur, expected) || user.get("id") != expected.user.get("id") {
                return false;
            }
            cur.user = user;
        }
        self.persist();
        true
    }

    pub fn clear_if_current(&self, expected: &Session) -> Result<bool, String> {
        let mut cur = self.current.lock().unwrap();
        if !Self::same_identity(&cur, expected) { return Ok(false); }
        let next = Session { revision: cur.revision.wrapping_add(1), ..Session::default() };
        self.save(&next).map_err(|_| "退出状态未能保存，请检查应用存储空间后重试")?;
        *cur = next;
        Ok(true)
    }

    #[cfg(test)]
    pub fn set(&self, origin: &str, token: String, user: serde_json::Value) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.origin = origin.to_string();
            cur.library_origin = None;
            cur.token = token;
            cur.user = user;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
    }

    pub fn clear(&self) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.library_origin = None;
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
    }

    fn persist(&self) {
        let snapshot = self.current.lock().unwrap();
        let _ = self.save(&snapshot);
    }

    // Callers hold current until rename so an older writer cannot overwrite a newer login.
    fn save(&self, session: &Session) -> std::io::Result<()> {
        use std::io::Write;
        let bound = self.file.lock().unwrap();
        let path = bound.as_ref().ok_or_else(|| std::io::Error::other("session directory unavailable"))?;
        let temp = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(session)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(temp, path)
    }
}
