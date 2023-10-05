{
    inputs = {
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
        rust-overlay.url = "github:oxalica/rust-overlay";
    };

    outputs = {
        self,
        nixpkgs,
        rust-overlay,
    }: let
        system = "x86_64-linux";
        pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
        };
        toolchain = pkgs.rust-bin.fromRustupToolchainFile ./toolchain.toml;
    in {
        devShells.${system}.default = pkgs.mkShell {
            packages = [
                toolchain
                pkgs.rust-analyzer-unwrapped
                pkgs.postgresql

                # remember that cargo test and other commands require the following dependencies
                pkgs.pkg-config
                pkgs.openssl
            ];

            RUST_SRC_PATH = "${toolchain}/lib/rustlib/src/rust/library";

            shellHook = ''
            # stop and remove any old Postgresql container
            docker rm -f postgres || true

            # spin up the Postgresql container
            docker run --rm --name postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:13

            cargo check     
            '';
        };
    };
}
