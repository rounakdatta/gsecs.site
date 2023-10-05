use std::{io::Result, net::TcpListener};

use gsecs_site::run;

#[tokio::main]
async fn main() -> Result<()> {
    // note how setting the port 0 here, asks the OS to allot an available port randomly
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind random port");
    run(listener)?.await
}
