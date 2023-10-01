#[macro_use]
extern crate rocket;

use rocket::fairing::AdHoc;
use rocket::futures::lock::Mutex;

mod api;
mod db;

#[launch]
fn rocket() -> _ {
    rocket::build()
    .attach(AdHoc::on_ignite("SQLx config", |rocket| async {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = db::create_pool(&database_url).await;
        rocket.manage(Mutex::new(pool))
    }))
    .mount("/api", api::configure())
}
