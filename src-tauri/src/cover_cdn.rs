//! WebP cover rules published as JSON by the active official site.
use crate::net::{self, RequestScope};
use crate::network_policy::parse_target_with_mode;
use dom_query::Document;
use serde::Deserialize;
use std::future::Future;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use url::Url;

const CONFIG_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_HTML_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
struct Webp {
    enabled: bool,
    base: String,
    hosts: Vec<String>,
}

impl Webp {
    fn from_html(html: &str) -> Option<Self> {
        let document = Document::from(html);
        let config = document.select("script#crypto-image-config[type='application/json']");
        if config.length() != 1 {
            return None;
        }
        let data: serde_json::Value = serde_json::from_str(&config.text()).ok()?;
        let mut rule: Self = serde_json::from_value(data.pointer("/cdn/webp")?.clone()).ok()?;
        let base = parse_target_with_mode(&rule.base, true).ok()?;
        if !rule.enabled || rule.hosts.is_empty() || rule.hosts.len() > 64
            || base.scheme() != "https" || base.query().is_some() || base.fragment().is_some()
            || !matches!(base.host(), Some(url::Host::Domain(_))) {
            return None;
        }
        rule.base = base.as_str().trim_end_matches('/').to_owned();
        Some(rule)
    }

    fn candidate(&self, site: &str, original: &Url) -> Option<String> {
        let host = original.host_str()?;
        if !self.hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(host))
            || (original.origin().ascii_serialization() == site && original.path().starts_with("/upload/")) {
            return None;
        }
        // Only the path is shared. Signatures, fragments and account headers belong to the original.
        Some(format!("{}{}.webp", self.base, original.path()))
    }
}

fn eligible_original(raw: &str) -> Option<Url> {
    let source = parse_target_with_mode(raw, true).ok()?;
    let path = source.path();
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    (source.scheme() == "https" && matches!(source.host(), Some(url::Host::Domain(_)))
        && source.port().is_none() && !path.starts_with("/static/")
        && matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp")).then_some(source)
}

async fn published_rule(site: &str) -> Option<Webp> {
    let mut response = net::get(site, CONFIG_TIMEOUT, Some("text/html"), None).await.ok()?;
    if !response.status().is_success() || response.url().origin().ascii_serialization() != site
        || response.content_length().is_some_and(|n| n > MAX_HTML_BYTES as u64) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > MAX_HTML_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Webp::from_html(std::str::from_utf8(&body).ok()?)
}

struct CachedRule {
    site: String,
    scope: RequestScope,
    expires: Instant,
    rule: Option<Webp>,
}
static RULE: Mutex<Option<CachedRule>> = Mutex::const_new(None);

pub(crate) async fn candidate(raw: &str, scope: RequestScope) -> Option<String> {
    let original = eligible_original(raw)?;
    let site = net::base();
    if net::is_custom_line() || !(crate::lines::is_fixed(&site) || crate::lines::is_trusted_mirror(&site)) {
        return None;
    }
    let mut cached = RULE.lock().await;
    if scope != net::request_scope() || site != net::base() { return None; }
    if let Some(entry) = cached.as_ref().filter(|e| e.site == site && e.scope == scope && e.expires > Instant::now()) {
        return entry.rule.as_ref()?.candidate(&site, &original);
    }
    let rule = tokio::time::timeout(CONFIG_TIMEOUT, published_rule(&site)).await.ok().flatten();
    if scope != net::request_scope() || site != net::base() { return None; }
    let candidate = rule.as_ref().and_then(|r| r.candidate(&site, &original));
    let ttl = Duration::from_secs(if rule.is_some() { 900 } else { 30 });
    *cached = Some(CachedRule { site, scope, expires: Instant::now() + ttl, rule });
    candidate
}

pub(crate) async fn load_with_fallback<T, F: Future<Output = Result<T, String>>>(
    original: &str, webp: Option<String>, load: impl Fn(String) -> F,
) -> Result<T, String> {
    if let Some(url) = webp {
        // A slow optional CDN must leave time for the signed original.
        if let Ok(Ok(image)) = tokio::time::timeout(Duration::from_secs(5), load(url)).await {
            return Ok(image);
        }
    }
    load(original.to_owned()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn webp_candidate(html: &str, site: &str, original: &str) -> Option<String> {
        Webp::from_html(html)?.candidate(site, &eligible_original(original)?)
    }

    #[tokio::test]
    async fn serves_published_webp_or_retries_the_exact_original_without_sharing_its_signature() {
        let html = r#"<script type="application/json" id="crypto-image-config">{"cdn":{"webp":{
            "enabled":true,"base":"https://webp.example/images/","hosts":["covers.example","site.example"]
        }}}</script>"#;
        let site = "https://site.example";
        let original = "https://covers.example/art/one%20cover.JPG?auth_key=test-only#fragment";
        let webp = "https://webp.example/images/art/one%20cover.JPG.webp";
        let candidate = webp_candidate(html, site, original);
        assert_eq!(candidate.as_deref(), Some(webp));
        for raw in ["https://foreign.example/art.jpg", "https://covers.example:8443/a.jpg",
            "https://user@covers.example/a.jpg", "https://covers.example/static/a.png",
            "https://site.example/upload/a.jpg", "https://covers.example/already.webp"] {
            assert_eq!(webp_candidate(html, site, raw), None);
        }
        assert_eq!(webp_candidate(&html.replace("true", "false"), site, original), None);
        assert_eq!(webp_candidate(&html.replace("https://webp.example", "http://webp.example"), site, original), None);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let webp_pixel = STANDARD.decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA").unwrap();
        let png = include_bytes!("../icons/32x32.png");
        for webp_available in [true, false] {
            let requests = RefCell::new(Vec::new());
            let (kind, bytes) = load_with_fallback(original, candidate.clone(), |url| {
                let payload = if url == original { png.to_vec() }
                    else if webp_available { webp_pixel.clone() } else { b"not an image".to_vec() };
                requests.borrow_mut().push(url);
                std::future::ready(crate::media::decode_cover(payload))
            }).await.unwrap();
            if webp_available {
                assert_eq!(kind, "image/webp");
                assert_eq!(bytes.as_slice(), webp_pixel);
                assert_eq!(requests.into_inner(), [webp]);
            } else {
                assert_eq!(kind, "image/png");
                assert_eq!(bytes.as_slice(), png);
                assert_eq!(requests.into_inner(), [webp, original]);
            }
        }
    }
}
