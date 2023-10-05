{ pkgs ? import <nixpkgs> {} }:

let
    unstablePkgs = import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz") {};
    rust = unstablePkgs.rustc;
    cargo = pkgs.cargo;
    openssl = pkgs.openssl;
in
pkgs.mkShell {
    buildInputs = [ rust cargo openssl pkgs.postgresql pkgs.pkg-config ];

    shellHook = ''
    # stop and remove any old Postgresql container
    docker rm -f postgres || true

    # spin up the Postgresql container
    docker run --rm --name postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:13

    # create the .env file
    echo "export DATABASE_URL=postgres://postgres:postgres@postgres/postgres" > .env

    export DATABASE_URL=postgres://postgres:postgres@postgres/postgres
    export SQLX_OFFLINE=true

    cargo build
    cargo run
    '';
}
