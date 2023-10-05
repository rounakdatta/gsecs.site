use sqlx::{migrate, PgPool};

pub async fn create_pool() -> Result<PgPool, sqlx::Error> {
    // TODO: refactor here to handle missing env var gracefully instead of panicking
    // we should return a custom application error in such cases
    let database_url = &std::env::var("DATABASE_URL").expect("DATABASE_URL must be set as environment variable");
    Ok(sqlx::PgPool::connect(database_url).await?)
}

pub async fn apply_migrations(pool: &PgPool) -> Result<(), migrate::MigrateError> {
    Ok(sqlx::migrate!().run(pool).await?)
}
