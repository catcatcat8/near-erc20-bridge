build:
	rustup target add wasm32-unknown-unknown
	cargo +nightly build --all --target wasm32-unknown-unknown --release
	cp target/wasm32-unknown-unknown/release/near_bridge_assist.wasm res/
deploy:
	make build
	near dev-deploy --wasmFile ./target/wasm32-unknown-unknown/release/near_bridge_assist.wasm --initFunction init --initArgs '{"owner": "gotbit.testnet", "relayer_role": "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", "token": "mytoken.gotbit.testnet", "fee_wallet": "gotbit.testnet", "limit_per_send":200, "fee_numerator":1000}'
deploy-ft:
	near deploy --accountId mytoken.gotbit.testnet --wasmFile ./res/fungible_token.wasm
	near call mytoken.gotbit.testnet new '{"owner_id": "gotbit.testnet", "total_supply": "1000000000000000000000000", "metadata": { "spec": "ft-1.0.0", "name": "Example Token Name", "symbol": "EXLT", "decimals": 18 }}' --accountId mytoken.gotbit.testnet
init-ft:
	near call mytoken.gotbit.testnet new '{"owner_id": "gotbit.testnet", "total_supply": "1000000000000000000000000", "metadata": { "spec": "ft-1.0.0", "name": "Example Token Name", "symbol": "EXLT", "decimals": 18 }}' --accountId mytoken.gotbit.testnet
register-me:
	near call mytoken.gotbit.testnet storage_deposit '{"account_id": "gotbit.testnet"}' --accountId gotbit.testnet --amount 0.00125
register-bridge:
	near call mytoken.gotbit.testnet storage_deposit '{"account_id": "bridge.gotbit.testnet"}' --accountId bridge.gotbit.testnet --amount 0.00125
collect:
	near call mytoken.gotbit.testnet ft_transfer_call '{"receiver_id": "bridge.gotbit.testnet", "amount": "150", "msg": "0x3ba"}' --accountId gotbit.testnet --depositYocto 1 --gas 300000000000000
