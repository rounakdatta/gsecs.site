#![allow(non_snake_case)]

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
pub struct Bond {
    pub id: i32,
    pub bondCode: String,
    pub issueDate: NaiveDateTime,
    pub isReissue: bool,
    pub repaymentDate: NaiveDateTime,
    pub auctionHappeningDate: NaiveDateTime,
    pub auctionSettlementDate: NaiveDateTime,
    pub pressReleaseWeblink: String
}
