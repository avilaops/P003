//! Private HTTPS transport; PDF interpretation remains in the isolated service.
use super::{
    bundle::{self, Verification, VerifiedBundle},
    transport::{self, Input, RequestContext, ServiceKey, WireError},
    trust::{ApprovedTrust, POLICY_SHA256},
};
use reqwest::{
    Certificate, Client, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use std::time::Duration;

pub(crate) struct ValidatorClient {
    http: Client,
    origin: Url,
    key: ServiceKey,
    trust: ApprovedTrust,
    deadline: Duration,
}
impl std::fmt::Debug for ValidatorClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ValidatorClient([REDACTED])")
    }
}
impl ValidatorClient {
    pub(crate) fn from_env() -> Result<Option<std::sync::Arc<Self>>, WireError> {
        super::client_config::load_with(|name| match std::env::var(name) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err(WireError),
        })
    }
    pub(super) fn new(
        origin: &str,
        ca: &[u8],
        key: ServiceKey,
        trust: ApprovedTrust,
    ) -> Result<Self, WireError> {
        let origin = Url::parse(origin).map_err(|_| WireError)?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
        {
            return Err(WireError);
        }
        if ca.is_empty() || ca.len() > 256 * 1024 {
            return Err(WireError);
        }
        let certificates = Certificate::from_pem_bundle(ca).map_err(|_| WireError)?;
        if certificates.is_empty() {
            return Err(WireError);
        }
        let mut builder = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .tls_built_in_root_certs(false)
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(55));
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
        Ok(Self {
            http: builder.build().map_err(|_| WireError)?,
            origin,
            key,
            trust,
            deadline: Duration::from_secs(55),
        })
    }
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Preflight is consumed by workflow plan task 3; remove this expectation when connected"
        )
    )]
    pub(super) async fn preflight(
        &self,
        context: RequestContext,
        base: &[u8],
    ) -> Result<VerifiedBundle, WireError> {
        self.validate(context, Input::Preflight { base }).await
    }
    pub(super) async fn validate(
        &self,
        context: RequestContext,
        input: Input<'_>,
    ) -> Result<VerifiedBundle, WireError> {
        if context.policy_sha256 != POLICY_SHA256
            || context.trust_bundle_sha256 != self.trust.sha256()
        {
            return Err(WireError);
        }
        let mut request = transport::encode(context, input)?;
        let authentication = self
            .key
            .authenticate(&request, time::OffsetDateTime::now_utc().unix_timestamp())?;
        let mut headers = HeaderMap::new();
        for (name, value) in authentication.headers() {
            let mut value = HeaderValue::from_str(value).map_err(|_| WireError)?;
            value.set_sensitive(true);
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| WireError)?,
                value,
            );
        }
        let url = self
            .origin
            .join(&format!("/internal/v1/{}", request.operation()))
            .map_err(|_| WireError)?;
        let mut response = self
            .http
            .post(url)
            .headers(headers)
            .timeout(self.deadline)
            .body(request.take_body())
            .send()
            .await
            .map_err(|_| WireError)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(WireError);
        }
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                Ok((
                    name.as_str().to_owned(),
                    value.to_str().map_err(|_| WireError)?.to_owned(),
                ))
            })
            .collect::<Result<Vec<_>, WireError>>()?;
        let normalized = bundle::response_headers(&headers, bundle::CONTENT_TYPE)?;
        let size = normalized["content-length"]
            .parse::<usize>()
            .map_err(|_| WireError)?;
        let mut body = Vec::with_capacity(size.min(64 * 1024));
        while let Some(chunk) = response.chunk().await.map_err(|_| WireError)? {
            if chunk.len() > size.saturating_sub(body.len()) {
                return Err(WireError);
            }
            body.extend_from_slice(&chunk);
        }
        if body.len() != size {
            return Err(WireError);
        }
        bundle::decode(
            body,
            &headers,
            Verification {
                request: &request,
                authentication: &authentication,
                key: &self.key,
                trust: &self.trust,
                now: time::OffsetDateTime::now_utc(),
            },
        )
    }
    #[cfg(test)]
    fn with_deadline(mut self, duration: Duration) -> Self {
        self.deadline = duration;
        self
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
