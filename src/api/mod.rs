pub mod bond;

pub fn configure() -> Vec<rocket::Route> {
    routes![
        bond::get_bonds,
    ]
}
