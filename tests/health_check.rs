use std::{net::TcpListener, fmt::format};

#[tokio::test]
async fn health_check_works() {
    let address = spawn_app();

    // create a testing reqwest client
    let client = reqwest::Client::new();
    let response = client
        .get(&format!("{}/health_check", &address))
        .send()
        .await
        .expect("Failed to execute the request");

    
    // the response code should be 200, but response should be empty
    assert!(response.status().is_success());
    assert_eq!(Some(0), response.content_length());
}

fn spawn_app() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind random port");
    let port = listener.local_addr().unwrap().port();

    let server = gsecs_site::run(listener).expect("Failed to bind address");
    let _ = tokio::spawn(server);
    
    format!("http://127.0.0.1:{}", port)
}
