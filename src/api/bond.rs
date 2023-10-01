use rocket::get;

use std::sync::Mutex;
use sqlx::PgPool;
use rocket::State;


#[get("/bonds")]
pub async fn get_bonds(db_pool: &State<Mutex<PgPool>>) -> String {
    let pool = db_pool.lock();
    let rows = sqlx::query!("SELECT * FROM bonds")
        .fetch_all(pool)
        .await
        .unwrap();

    format!("Fetched {} bonds", rows.len())
}
