#[macro_use]
extern crate rocket;

mod handlers;
mod db;
mod models;

use rocket::Rocket;

#[rocket::main]
async fn main() {
    let db_pool = db::create_pool()
        .await
        .expect("Db pool to be created");
    db::apply_migrations(&db_pool)
        .await
        .expect("Migrations to be applied");
    Rocket::build()
        .manage(db_pool)
        .launch()
        .await
        .expect("Server should start");
}
