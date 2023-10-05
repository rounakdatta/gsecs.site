CREATE TABLE gsec_bonds(
    id SERIAL PRIMARY KEY,
    bond_code VARCHAR(50) UNIQUE NOT NULL,
    issue_date DATE NOT NULL,
    is_reissue BOOLEAN NOT NULL,
    repayment_date DATE NOT NULL,
    auction_happening_date DATE NOT NULL,
    auction_settlement_date DATE NOT NULL,
    press_release_weblink TEXT
);
