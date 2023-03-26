use ed25519_dalek::{PublicKey as ed25519_dalek_PublicKey, Verifier};
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::StorageBalance;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, LookupSet, UnorderedSet, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    assert_one_yocto, bs58, env, ext_contract, near_bindgen, AccountId, Balance,
    BorshStorageKey, CryptoHash, CurveType, Gas, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PromiseResult, PublicKey, StorageUsage,
};

#[ext_contract(token_storage)]
pub trait ExtTokenStorage {
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance>;
}

const GAS_FOR_FULFILL: Gas = Gas(80_000_000_000_000);
const CURRENT_CHAIN: &str = "NEAR";
const MAX_ACCOUNT_ID_LENGTH: u8 = 64;
const ETH_ADDRESS_LENGTH: u8 = 42;
const FEE_DENOMINATOR: u16 = 10000;
const MIN_TOKEN_STORAGE_DEPOSIT: u128 = 1250000000000000000000;

#[derive(BorshDeserialize, BorshSerialize, Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Transaction {
    from_user: String,
    to_user: String,
    amount: U128,
    timestamp: U64,
    from_chain: String,
    to_chain: String,
    nonce: U128,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
struct BridgeAssist {
    bytes_for_register: StorageUsage,
    bytes_for_ft_on_transfer: StorageUsage,
    bytes_for_fulfill: StorageUsage,
    bytes_for_add_chain: StorageUsage,
    owner: AccountId,
    relayer_role: PublicKey,
    token: AccountId,
    fee_wallet: AccountId,
    limit_per_send: Balance,
    nonce: U128,
    fee_numerator: u16,
    transactions: LookupMap<String, Vector<Transaction>>,
    fulfilled: LookupSet<String>,
    storage_paid: LookupMap<AccountId, Balance>,
    total_storage_paid: Balance,
    available_chains: UnorderedSet<String>,
}

/// Helper structure for keys of the persistent collections
#[derive(BorshStorageKey, BorshSerialize)]
pub enum StorageKey {
    Transactions,
    TransactionsInner { account_id_hash: CryptoHash },
    Fulfilled,
    StoragePaid,
    AvailableChains,
}

/*
    Trait that will be used as the callback from the FT contract. When ft_transfer_call() is
    called, it will fire a cross contract call to BridgeAssist and this is the function
    that is invoked.
*/
#[near_bindgen]
impl FungibleTokenReceiver for BridgeAssist {
    // Sends tokens on another chain by user
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        // Require only specified FT can be used
        let ft_contract_id = env::predecessor_account_id();
        if ft_contract_id != self.token {
            env::log_str("PANIC: Not supported fungible token");
            env::panic_str("Not supported fungible token");
        }

        // Require the signer isn't the predecessor. This is so that we're sure
        // this was called via a cross-contract call from FT
        let signer_id = env::signer_account_id();
        if ft_contract_id == signer_id {
            env::log_str("PANIC: Should only be called via cross-contract call");
            env::panic_str("Should only be called via cross-contract call");
        }
        if sender_id != signer_id {
            env::log_str("PANIC: Sender_id is not the signer of tx");
            env::panic_str("Sender_id is not the signer of tx");
        }

        if msg.len() as u8 <= ETH_ADDRESS_LENGTH {
            env::log_str(
                "PANIC: 42 hexadecimal characters as ETH address should be specified in msg field + destination chain",
            );
            env::panic_str(
                "42 hexadecimal characters as ETH address should be specified in msg field + destination chain",
            );
        }

        let eth_address = &msg[0..ETH_ADDRESS_LENGTH as usize];
        let chain = &msg[ETH_ADDRESS_LENGTH as usize..];

        if !self.is_available_chain(String::from(chain)) {
            env::log_str("PANIC: Chain is not supported");
            env::panic_str("Chain is not supported")
        }

        let user_storage_paid = self.storage_paid.get(&sender_id).unwrap_or_else(|| {
            env::log_str("PANIC: Not storage paid");
            env::panic_str("Not storage paid")
        });
        let storage_paid_for_ft_on_transfer = self.bytes_for_ft_on_transfer as u128 * env::STORAGE_PRICE_PER_BYTE;
        if user_storage_paid < storage_paid_for_ft_on_transfer {
            env::log_str("PANIC: Not enough storage paid");
            env::panic_str("Not enough storage paid");
        }

        // Limits check
        if Balance::from(amount) > self.limit_per_send {
            env::log_str("PANIC: Amount is over the limit per 1 send");
            env::panic_str("Amount is over the limit per 1 send");
        }

        let tx_data = Transaction {
            from_user: sender_id.to_string(),
            to_user: String::from(eth_address),
            amount: U128::from(amount),
            timestamp: U64::from(env::block_timestamp() / 1_000_000_000),
            from_chain: String::from(CURRENT_CHAIN),
            to_chain: String::from(chain),
            nonce: self.nonce,
        };

        // Insert tx_data in LookupMap
        let mut tx_vector = self
            .transactions
            .get(&tx_data.from_user)
            .unwrap_or_else(|| {
                Vector::new(StorageKey::TransactionsInner {
                    account_id_hash: env::sha256_array(sender_id.as_bytes()),
                })
            });
        tx_vector.push(&tx_data);
        self.transactions.insert(&tx_data.from_user, &tx_vector);

        // Update storage paid
        let new_storage_paid =
            user_storage_paid - storage_paid_for_ft_on_transfer;
        self.storage_paid.insert(&sender_id, &new_storage_paid);
        self.total_storage_paid = self.total_storage_paid - storage_paid_for_ft_on_transfer;

        // Increment nonce
        self.nonce = U128::from(u128::from(self.nonce) + 1 as u128);

        let log = format!(
            "Sent {} tokens from {} to {} in direction {}->{}",
            Balance::from(amount),
            sender_id,
            String::from(eth_address),
            CURRENT_CHAIN,
            String::from(chain)
        );
        env::log_str(&log);
        PromiseOrValue::Value(U128::from(0))
    }
}

#[near_bindgen]
impl BridgeAssist {
    #[init]
    pub fn init(
        owner: AccountId,
        relayer_role: String,
        token: AccountId,
        fee_wallet: AccountId,
        limit_per_send: U128,
        fee_numerator: u16,
    ) -> Self {
        if fee_numerator >= FEE_DENOMINATOR {
            env::panic_str("Fee is to high");
        }
        let relayer: PublicKey = relayer_role.parse().unwrap_or_else(|_| {
            env::panic_str("Relayer role is not convertible to PublicKey type")
        });
        if relayer.curve_type() != CurveType::ED25519 {
            env::panic_str("The only supported curve type for relayer role is ED25519");
        }
        let mut this = Self {
            bytes_for_register: 0,
            bytes_for_ft_on_transfer: 0,
            bytes_for_fulfill: 0,
            bytes_for_add_chain: 0,
            owner,
            relayer_role: relayer,
            token,
            fee_wallet,
            limit_per_send: Balance::from(limit_per_send),
            nonce: U128::from(0),
            fee_numerator,
            transactions: LookupMap::new(StorageKey::Transactions),
            fulfilled: LookupSet::new(StorageKey::Fulfilled),
            storage_paid: LookupMap::new(StorageKey::StoragePaid),
            total_storage_paid: Balance::from(0 as u128),
            available_chains: UnorderedSet::new(StorageKey::AvailableChains),
        };
        this.measure_bytes_for_functions();
        this
    }

    // Fulfills transaction from another chain
    #[payable]
    pub fn fulfill(&mut self, transaction: Transaction, signature: Vec<u8>) {
        assert_one_yocto();
        if env::prepaid_gas() < GAS_FOR_FULFILL {
            env::panic_str("Not enough gas prepaid, at least 80 Tgas is needed");
        }
        let to_user = AccountId::try_from(transaction.to_user.clone()).unwrap_or_else(|_| {
            env::panic_str("Not convertible transaction.to field to AccountId type")
        });
        if transaction.to_chain != CURRENT_CHAIN {
            env::panic_str("Wrong 'toChain' in tx struct");
        }
        if !self.is_available_chain(transaction.from_chain.clone()) {
            env::panic_str("Not supported fromChain in tx struct");
        }

        let user_storage_paid = self
            .storage_paid
            .get(&to_user)
            .unwrap_or_else(|| env::panic_str("Not storage paid"));
        let storage_paid_for_fulfill = self.bytes_for_fulfill as u128 * env::STORAGE_PRICE_PER_BYTE;
        if user_storage_paid < storage_paid_for_fulfill {
            env::panic_str("Not enough storage paid");
        }

        // Update storage paid
        let new_storage_paid =
            user_storage_paid - storage_paid_for_fulfill;
        self.storage_paid.insert(&to_user, &new_storage_paid);
        self.total_storage_paid = self.total_storage_paid - storage_paid_for_fulfill;

        // Tx reply check
        let tx_hash_bytes = self.get_tx_hash(&transaction);
        let tx_hash = hex::encode(tx_hash_bytes.clone());
        if self.fulfilled.contains(&tx_hash) {
            env::panic_str("Tx has already been fulfilled");
        }

        // Signature check
        let signature = ed25519_dalek::Signature::try_from(signature.as_ref())
            .unwrap_or_else(|_| env::panic_str("Signature should be a valid array of 64 bytes"));
        let relayer_role_pub_key_without_prefix =
            &String::try_from(&self.relayer_role).unwrap()[8..];
        let relayer_role_pub_key = ed25519_dalek_PublicKey::from_bytes(
            &bs58::decode(relayer_role_pub_key_without_prefix)
                .into_vec()
                .unwrap(),
        )
        .unwrap();

        match relayer_role_pub_key.verify(&tx_hash_bytes, &signature) {
            Ok(()) => {
                env::log_str("Signature has been verified");
                self.fulfilled.insert(&tx_hash);
            }
            Err(_) => env::panic_str("Wrong signature"),
        };

        let current_fee =
            u128::from(transaction.amount) * self.fee_numerator as u128 / FEE_DENOMINATOR as u128;

        if current_fee != 0 as u128 {
            token_storage::ext(self.token.clone())
                .storage_balance_of(self.fee_wallet.clone())
                .then(Self::ext(env::current_account_id()).resolve_fulfill(
                    current_fee,
                    &transaction,
                    &tx_hash,
                    to_user.clone(),
                    storage_paid_for_fulfill
                ));
        } else {
            self.dispense_ft_to_user(&transaction, &tx_hash, current_fee, to_user.clone(), storage_paid_for_fulfill);
        }
    }

    // Callback for fulfill
    #[private]
    pub fn resolve_fulfill(
        &mut self,
        #[callback_result] callback_result: Result<Option<StorageBalance>, PromiseError>,
        current_fee: u128,
        transaction: &Transaction,
        tx_hash: &String,
        to_user: AccountId,
        storage_paid_for_call: Balance
    ) {
        if callback_result.is_err() {
            env::log_str("fee wallet didn't storage deposit to token (you can call storage_deposit function on token contract for fee_wallet)");
            self.rollback_state(&tx_hash, to_user.clone(), storage_paid_for_call);
        } else {
            let result = callback_result.unwrap().unwrap_or(StorageBalance {
                total: U128(0),
                available: U128(0),
            });
            if result.total < U128::from(MIN_TOKEN_STORAGE_DEPOSIT) {
                env::log_str("fee wallet didn't storage deposit to token (you can call storage_deposit function on token contract for fee_wallet)");
                self.rollback_state(&tx_hash, to_user.clone(), storage_paid_for_call);
            } else {
                self.dispense_ft_to_user(&transaction, &tx_hash, current_fee, to_user.clone(), storage_paid_for_call);
            }
        }
    }

    #[private]
    pub fn dispense_ft_to_user(
        &mut self,
        transaction: &Transaction,
        tx_hash: &String,
        current_fee: u128,
        to_user: AccountId,
        storage_paid_for_call: Balance
    ) {
        let dispense_amount = u128::from(transaction.amount) - current_fee;

        let log = format!(
            "Dispense {} tokens from {} to {} in direction {}->{}",
            dispense_amount,
            transaction.from_user,
            to_user,
            transaction.from_chain.clone(),
            CURRENT_CHAIN
        );
        env::log_str(&log);

        // Transfer FT to user
        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(1)
            .ft_transfer(
                to_user.clone(),
                U128::from(dispense_amount),
                Some("Dispensing from bridge".to_string()),
            )
            .then(Self::ext(env::current_account_id()).resolve_dispense(
                &tx_hash,
                &transaction,
                to_user.clone(),
                current_fee,
                storage_paid_for_call
            ));
    }

    // Callback for dispense_ft_to_user
    #[private]
    pub fn resolve_dispense(
        &mut self,
        tx_hash: &String,
        tx: &Transaction,
        to_user: AccountId,
        fee: u128,
        storage_paid_for_call: Balance
    ) {
        let is_reverted = match env::promise_result(0) {
            PromiseResult::NotReady => env::abort(),
            PromiseResult::Successful(_) => false,
            PromiseResult::Failed => true,
        };

        // rollback state if the promise is failed
        if is_reverted {
            env::log_str("ft_transfer promise failed (maybe you should call storage_deposit function on token contract for to_user in tx struct)");
            self.rollback_state(&tx_hash, to_user.clone(), storage_paid_for_call);
        } else {
            // Else add tx in list and dispense fee if it is not equal to 0
            let mut tx_vector = self.transactions.get(&tx.from_user).unwrap_or_else(|| {
                Vector::new(StorageKey::TransactionsInner {
                    account_id_hash: env::sha256_array(tx.from_user.as_bytes()),
                })
            });
            tx_vector.push(&tx);
            self.transactions.insert(&tx.from_user, &tx_vector);
            if fee != 0 as u128 {
                ext_ft_core::ext(self.token.clone())
                    .with_attached_deposit(1)
                    .ft_transfer(
                        self.fee_wallet.clone(),
                        U128::from(fee),
                        Some("Transferring fee".to_string()),
                    );
            }
        }
    }

    #[private]
    pub fn rollback_state(&mut self, tx_hash: &String, to_user: AccountId, storage_paid_for_call: Balance) {
        self.fulfilled.remove(tx_hash);
        let user_storage_paid = self.storage_paid.get(&to_user).unwrap();
        let new_storage_paid =
            user_storage_paid + storage_paid_for_call;
        self.storage_paid.insert(&to_user, &new_storage_paid);
        self.total_storage_paid = self.total_storage_paid + storage_paid_for_call;
    }

    /*
        ----------------------------
        Storage management functions
        ----------------------------
    */
    #[private]
    pub fn measure_bytes_for_functions(&mut self) {
        // for first register
        let initial_storage_usage = env::storage_usage();
        let tmp_account_id = AccountId::new_unchecked("a".repeat(MAX_ACCOUNT_ID_LENGTH.into()));
        self.storage_paid.insert(&tmp_account_id, &0u128);
        self.bytes_for_register = env::storage_usage() - initial_storage_usage;
        self.storage_paid.remove(&tmp_account_id);

        // for one call ft_on_transfer
        let initial_storage_usage = env::storage_usage();
        let to_addr = String::from("a".repeat(ETH_ADDRESS_LENGTH.into()));
        let tx_data = Transaction {
            from_user: tmp_account_id.to_string(),
            to_user: to_addr.clone(),
            amount: U128::from(0u128),
            timestamp: U64::from(0),
            from_chain: String::from("a".repeat(64)),
            to_chain: String::from("a".repeat(64)),
            nonce: U128::from(0),
        };
        let mut tx_vector = self
            .transactions
            .get(&tx_data.from_user)
            .unwrap_or_else(|| {
                Vector::new(StorageKey::TransactionsInner {
                    account_id_hash: env::sha256_array(tmp_account_id.as_bytes()),
                })
            });
        tx_vector.push(&tx_data);
        self.transactions.insert(&tx_data.from_user, &tx_vector);
        self.bytes_for_ft_on_transfer = env::storage_usage() - initial_storage_usage;
        self.transactions.remove(&tx_data.from_user);

        // for successful fulfill
        let initial_storage_usage = env::storage_usage();
        let tx_hash_bytes = env::keccak256(
            &bincode::serialize(&tx_data)
                .unwrap_or_else(|_| env::panic_str("Serializing transaction field is failed")),
        );
        let tx_hash = hex::encode(tx_hash_bytes);
        self.fulfilled.insert(&tx_hash);
        self.bytes_for_fulfill =
            env::storage_usage() - initial_storage_usage + self.bytes_for_ft_on_transfer;
        self.fulfilled.remove(&tx_hash);

        // for add chain
        let initial_storage_usage = env::storage_usage();
        let average_chain = String::from("A".repeat(5));
        self.available_chains.insert(&average_chain);
        self.bytes_for_add_chain = env::storage_usage() - initial_storage_usage;
        self.available_chains.remove(&average_chain);
    }

    #[payable]
    pub fn storage_deposit(&mut self) {
        let user = env::predecessor_account_id();
        let attached_near = env::attached_deposit();
        if !self.storage_paid.contains_key(&user) {
            if attached_near < self.bytes_for_register as u128 * env::STORAGE_PRICE_PER_BYTE {
                env::panic_str("Not enough NEAR attached");
            }
            let excess =
                attached_near - self.bytes_for_register as u128 * env::STORAGE_PRICE_PER_BYTE;
            self.storage_paid.insert(&user, &excess);
            self.total_storage_paid = self.total_storage_paid + excess;
        } else {
            let new_storage_balance = self.storage_paid.get(&user).unwrap() + attached_near;
            self.storage_paid.insert(&user, &new_storage_balance);
            self.total_storage_paid = self.total_storage_paid + attached_near;
        }
    }

    pub fn storage_withdraw(&mut self, amount: U128) {
        let amount = u128::from(amount);
        let user = env::predecessor_account_id();
        let user_storage_paid = self
            .storage_paid
            .get(&user)
            .unwrap_or_else(|| env::panic_str("No storage paid"));
        if amount > user_storage_paid {
            env::panic_str("Amount is more than your storage paid");
        } else {
            Promise::new(user.clone()).transfer(amount);
            self.storage_paid
                .insert(&user, &(user_storage_paid - amount));
            self.total_storage_paid = self.total_storage_paid - amount;
        }
    }

    /*
        ------------------------
        Administrative functions
        ------------------------
    */
    #[private]
    pub fn only_owner(&self, caller: AccountId) {
        if caller != self.owner {
            env::panic_str("Only owner function");
        }
    }

    #[payable]
    pub fn add_chain(&mut self, chain: String) {
        self.only_owner(env::predecessor_account_id());
        if self.available_chains.contains(&chain) {
            env::panic_str("Chain is already in the list");
        }
        let attached_near = env::attached_deposit();
        if attached_near < self.bytes_for_add_chain as u128 * env::STORAGE_PRICE_PER_BYTE {
            env::panic_str("Not enough NEAR attached");
        }
        let initial_storage_usage = env::storage_usage();
        self.available_chains.insert(&chain);
        if attached_near
            < (env::storage_usage() - initial_storage_usage) as u128 * env::STORAGE_PRICE_PER_BYTE
        {
            env::panic_str("Not enough NEAR attached");
        }
    }

    pub fn remove_chain(&mut self, chain: String) {
        self.only_owner(env::predecessor_account_id());
        if !self.available_chains.contains(&chain) {
            env::panic_str("Chain is not in the list yet");
        }
        let initial_storage_usage = env::storage_usage();
        self.available_chains.remove(&chain);
        let repayment =
            (initial_storage_usage - env::storage_usage()) as u128 * env::STORAGE_PRICE_PER_BYTE;
        Promise::new(env::predecessor_account_id()).transfer(repayment);
    }

    pub fn transfer_ownership(&mut self, owner: AccountId) {
        self.only_owner(env::predecessor_account_id());
        if owner == self.owner {
            env::panic_str("Current owner is equal to new owner");
        }
        self.owner = owner;
    }

    pub fn set_fee_numerator(&mut self, fee_numerator: u16) {
        self.only_owner(env::predecessor_account_id());
        if fee_numerator == self.fee_numerator {
            env::panic_str("Current fee is equal to new fee");
        }
        if fee_numerator >= FEE_DENOMINATOR {
            env::panic_str("Fee is to high");
        }
        self.fee_numerator = fee_numerator;
    }

    pub fn set_fee_wallet(&mut self, fee_wallet: AccountId) {
        self.only_owner(env::predecessor_account_id());
        if fee_wallet == self.fee_wallet {
            env::panic_str("Current feeWallet is equal to new feeWallet");
        }
        self.fee_wallet = fee_wallet;
    }

    pub fn set_limit_per_send(&mut self, limit_per_send: U128) {
        self.only_owner(env::predecessor_account_id());
        if Balance::from(limit_per_send) == self.limit_per_send {
            env::panic_str("Current limit is equal to new limit");
        }
        self.limit_per_send = Balance::from(limit_per_send);
    }

    pub fn set_relayer_role(&mut self, relayer: String) {
        self.only_owner(env::predecessor_account_id());
        let relayer: PublicKey = relayer
            .parse()
            .unwrap_or_else(|_| env::panic_str("Not convertible to PublicKey type"));
        if relayer.curve_type() != CurveType::ED25519 {
            env::panic_str("The only supported curve type for relayer role is ED25519");
        }
        if relayer == self.relayer_role {
            env::panic_str("Current relayer is equal to new relayer");
        }
        self.relayer_role = relayer;
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.only_owner(env::predecessor_account_id());
        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(1)
            .ft_transfer(
                self.owner.clone(),
                U128::from(amount),
                Some("Withdraw from bridge".to_string()),
            )
    }

    #[payable]
    pub fn withdraw_native_fee(&mut self, amount: U128) {
        assert_one_yocto();
        self.only_owner(env::predecessor_account_id());
        if u128::from(amount) > env::account_balance() {
            env::panic_str("Amount is more than contract balance");
        }
        if env::account_balance() - u128::from(amount) < self.total_storage_paid {
            env::panic_str("Left contract balance is less than users total storage paid");
        }
        Promise::new(self.owner.clone()).transfer(u128::from(amount));
    }

    /*
        --------------
        View functions
        --------------
    */
    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_relayer_role(&self) -> PublicKey {
        self.relayer_role.clone()
    }

    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }

    pub fn get_fee_info(&self) -> (AccountId, u16, u16) {
        (self.fee_wallet.clone(), self.fee_numerator, FEE_DENOMINATOR)
    }

    pub fn get_limit_per_send(&self) -> U128 {
        U128::from(self.limit_per_send)
    }

    pub fn get_nonce(&self) -> U128 {
        self.nonce
    }

    pub fn get_transaction_by_user(&self, user: String, index: U64) -> Transaction {
        let txs = self.transactions.get(&user).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(user.as_bytes()),
            })
        });
        txs.get(u64::from(index))
            .unwrap_or_else(|| env::panic_str("Index out of range"))
    }

    pub fn get_transactions_by_user(&self, user: String) -> Vec<Transaction> {
        let txs = self.transactions.get(&user).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(user.as_bytes()),
            })
        });
        txs.to_vec()
    }

    pub fn get_transactions_amount_by_user(&self, user: String) -> U64 {
        let txs = self.transactions.get(&user).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(user.as_bytes()),
            })
        });
        U64(txs.len())
    }

    pub fn is_tx_fulfilled(&self, tx_hash: String) -> bool {
        self.fulfilled.contains(&tx_hash)
    }

    pub fn get_storage_paid_info(&self, user: AccountId) -> (bool, U128, U128, U128, U128, U128) {
        let storage_cost = env::STORAGE_PRICE_PER_BYTE;
        (
            self.storage_paid.contains_key(&user),
            U128::from(self.storage_paid.get(&user).unwrap_or(0 as u128)),
            U128::from(self.bytes_for_register as u128 * storage_cost),
            U128::from(self.bytes_for_ft_on_transfer as u128 * storage_cost),
            U128::from(self.bytes_for_fulfill as u128 * storage_cost),
            U128::from(self.total_storage_paid)
        )
    }

    pub fn get_pay_for_add_chain(&self) -> U128 {
        U128::from(self.bytes_for_add_chain as u128 * env::STORAGE_PRICE_PER_BYTE)
    }

    pub fn is_available_chain(&self, chain: String) -> bool {
        self.available_chains.contains(&chain)
    }

    pub fn supported_chain_list(&self) -> Vec<String> {
        self.available_chains.to_vec()
    }

    pub fn get_tx_hash(&self, transaction: &Transaction) -> Vec<u8> {
        env::keccak256(
            &bincode::serialize(&transaction)
                .unwrap_or_else(|_| env::panic_str("Serializing transaction field is failed")),
        )
    }
}
