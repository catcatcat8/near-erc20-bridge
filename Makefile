build:
	rustup target add wasm32-unknown-unknown
	cargo build --all --target wasm32-unknown-unknown --release
deploy:
	rustup target add wasm32-unknown-unknown
	cargo build --all --target wasm32-unknown-unknown --release
	near deploy --accountId bridge.gotbit.testnet --wasmFile ./target/wasm32-unknown-unknown/release/near_bridge_assist.wasm --initFunction init --initArgs '{"owner": "gotbit.testnet", "token": "mytoken.gotbit.testnet", "limit_per_send":100}'
deploy-ft:
	near deploy --accountId mytoken.gotbit.testnet --wasmFile ./res/fungible_token.wasm