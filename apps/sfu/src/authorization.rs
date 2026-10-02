use futures_util::{SinkExt, StreamExt};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

pub type Lease = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn send_with_lease<A, S, E>(authorization: Pin<&mut A>, send: S) -> bool
where
    A: Future<Output = ()>,
    S: Future<Output = Result<(), E>>,
{
    tokio::select! {
        biased;
        _ = authorization => false,
        result = tokio::time::timeout(Duration::from_secs(5),send) => matches!(result,Ok(Ok(()))),
    }
}

/// Join succeeds only after the API registers this session and membership.
/// A disconnected/stalled API never leaves media authorized indefinitely.
pub async fn acquire(url: &str, token: &str) -> anyhow::Result<Lease> {
    let mut request = url.into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse()?);
    let (mut lease, _) =
        tokio::time::timeout(Duration::from_secs(5), connect_async(request)).await??;
    let ready = tokio::time::timeout(Duration::from_secs(5), lease.next())
        .await?
        .ok_or_else(|| anyhow::anyhow!("authorization connection closed"))??;
    match ready {
        Message::Text(text)
            if serde_json::from_str::<serde_json::Value>(&text)?["authorized"] == true =>
        {
            Ok(lease)
        }
        _ => anyhow::bail!("API did not authorize the media session"),
    }
}

pub async fn hold(lease: Lease) {
    hold_with_deadlines(lease, Duration::from_secs(15), Duration::from_secs(40)).await;
}

async fn hold_with_deadlines(mut lease: Lease, interval: Duration, stale: Duration) {
    let mut heartbeat = tokio::time::interval(interval);
    let mut last_reply = tokio::time::Instant::now();
    loop {
        tokio::select! {
            incoming = lease.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) if text == "pong" => last_reply = tokio::time::Instant::now(),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(_)) => {},
                }
            }
            _ = heartbeat.tick() => {
                if last_reply.elapsed() >= stale { return; }
                match tokio::time::timeout(Duration::from_secs(5), lease.send(Message::Text("ping".into()))).await {
                    Ok(Ok(())) => {},
                    _ => return,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio_tungstenite::accept_async;

    #[tokio::test]
    async fn revocation_interrupts_a_client_that_never_drains_writes() {
        let (revoke, revoked) = oneshot::channel();
        let authorization = async {
            let _ = revoked.await;
        };
        tokio::pin!(authorization);
        let write = futures_util::future::pending::<Result<(), ()>>();
        revoke.send(()).unwrap();
        assert!(
            !tokio::time::timeout(
                Duration::from_secs(1),
                send_with_lease(authorization.as_mut(), write)
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn api_revocation_ends_a_live_lease() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/authorization", listener.local_addr().unwrap());
        let (revoke, revoked) = oneshot::channel();
        let (started, ready) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text("{\"authorized\":true}".into()))
                .await
                .unwrap();
            let _ = started.send(());
            let _ = revoked.await;
            socket.close(None).await.unwrap();
        });
        let lease = acquire(&url, "synthetic-token").await.unwrap();
        ready.await.unwrap();
        let held = tokio::spawn(hold(lease));
        revoke.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), held)
            .await
            .unwrap()
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unresponsive_api_fails_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/authorization", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text("{\"authorized\":true}".into()))
                .await
                .unwrap();
            // Drain without answering heartbeats, emulating a stuck API.
            while socket.next().await.is_some() {}
        });
        let lease = acquire(&url, "synthetic-token").await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            hold_with_deadlines(lease, Duration::from_millis(10), Duration::from_millis(25)),
        )
        .await
        .unwrap();
        server.abort();
    }
}
