use crate::models::bond::Bond;
use sqlx::PgPool;
use rocket::{http, response::status, serde::json::Json, Route, State};

#[get("/")]
async fn get_all(pool: &State<PgPool>) -> Result<Json<Vec<Bond>>, status::Custom<&str>> {
    let pool = pool.inner().clone();
    sqlx::query_as!(Bond, "SELECT * FROM gsec_bonds")
    .fetch_all(&pool)
    .await
    .map_err(|_err| status::Custom(http::Status::InternalServerError, "Something went wrong!"))
    .map(Json)
}

pub fn register() -> Vec<Route> {
    routes![
        get_all,
    ]
}
