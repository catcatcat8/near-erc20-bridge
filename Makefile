build:
	rustup target add wasm32-unknown-unknown
	cargo +nightly build --all --target wasm32-unknown-unknown --release
	cp target/wasm32-unknown-unknown/release/near_bridge_assist.wasm res/

create-bridge-account:
	near create-account nearbridgev4.gotbit.testnet --masterAccount gotbit.testnet --initialBalance 10
create-token-account:
	near create-account parastoken.gotbit.testnet --masterAccount gotbit.testnet --initialBalance 10

add-chain:
	near call nearbridgev2.gotbit.testnet add_chain '{"chain": "AVAX"}' --accountId gotbit.testnet --amount 0.1
available-chains:
	near view nearbridgev2.gotbit.testnet supported_chain_list

deploy:
	make build
	near deploy --accountId nearbridgev4.gotbit.testnet --wasmFile ./target/wasm32-unknown-unknown/release/near_bridge_assist.wasm --initFunction init --initArgs '{"owner": "gotbit.testnet", "relayer_role": "ed25519:DTRVwm7mmqCxfTZTFwi2kgp5vuYB3aiaB67vqcLXCpmh", "token": "parastoken.gotbit.testnet", "fee_wallet": "gotbit.testnet", "limit_per_send":"1000000000000000000000", "fee_numerator":1000}' > deployments/testnet/BridgeAssist.txt
deploy-ft:
	near deploy --accountId parastoken.gotbit.testnet --wasmFile ./res/fungible_token.wasm > deployments/testnet/Token.txt
	near call parastoken.gotbit.testnet new '{"owner_id": "gotbit.testnet", "total_supply": "1000000000000000000000000", "metadata": { "spec": "ft-1.0.0", "name": "Paras Token", "symbol": "PARAS", "decimals": 18 }}' --accountId parastoken.gotbit.testnet

register-me:
	near call parastoken.gotbit.testnet storage_deposit '{"account_id": "gotbit.testnet"}' --accountId gotbit.testnet --amount 0.00125
register-bridge:
	near call parastoken.gotbit.testnet storage_deposit '{"account_id": "nearbridgev4.gotbit.testnet"}' --accountId nearbridgev4.gotbit.testnet --amount 0.00125

collect:
	near call mytoken.gotbit.testnet ft_transfer_call '{"receiver_id": "bridge.gotbit.testnet", "amount": "150", "msg": "0x3ba"}' --accountId gotbit.testnet --depositYocto 1 --gas 300000000000000
