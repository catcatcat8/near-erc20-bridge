use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, LookupSet, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    assert_one_yocto, env, near_bindgen, serde_json, AccountId, Balance, BorshStorageKey,
    CryptoHash, Gas, PanicOnDefault, Promise, PromiseOrValue, PromiseResult, PublicKey,
    StorageUsage,
};

const MAX_ACCOUNT_ID_LENGTH: u8 = 64;
const ETH_ADDRESS_LENGTH: u8 = 42;

const ECRECOVER_V: u8 = 0;
const ECRECOVER_M: bool = false;

const FEE_DENOMINATOR: u16 = 10000;

const GAS_FOR_RESOLVE_FULFILLED_SIG: Gas = Gas(30_000_000_000_000);

// //initiate a cross contract call to the nft contract. This will transfer the token to the buyer and return
// //a payout object used for the market to distribute funds to the appropriate accounts.
// #[ext_contract(ext_ft_contract)]
// trait ExtFtContract {
//     fn ft_transfer(
//         &mut self,
//         receiver_id: AccountId,
//         amount: U128,
//         memo: Option<String>
//     );
// }

#[derive(BorshDeserialize, BorshSerialize, Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Transaction {
    from: String,
    to: String,
    amount: U128,
    timestamp: U64,
    nonce: U128,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
struct BridgeAssist {
    bytes_for_register: StorageUsage,
    bytes_for_ft_on_transfer: StorageUsage,
    bytes_for_fulfill: StorageUsage,
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
}

/// Helper structure for keys of the persistent collections
#[derive(BorshStorageKey, BorshSerialize)]
pub enum StorageKey {
    Transactions,
    TransactionsInner { account_id_hash: CryptoHash },
    Fulfilled,
    StoragePaid,
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

        if msg.len() as u8 != ETH_ADDRESS_LENGTH {
            env::log_str(
                "PANIC: 42 hexadecimal characters as ETH address should be specified in msg field",
            );
            env::panic_str(
                "42 hexadecimal characters as ETH address should be specified in msg field",
            );
        }

        let user_storage_paid = self.storage_paid.get(&sender_id).unwrap_or_else(|| {
            env::log_str("PANIC: Not storage paid");
            env::panic_str("Not storage paid")
        });
        if user_storage_paid < self.bytes_for_ft_on_transfer as u128 * env::STORAGE_PRICE_PER_BYTE {
            env::log_str("PANIC: Not enough storage paid");
            env::panic_str("Not enough storage paid");
        }

        // Limits check
        let mut amount = Balance::from(amount);
        let mut amount_to_return = 0;
        if amount > self.limit_per_send {
            amount_to_return = amount - self.limit_per_send;
            amount = self.limit_per_send;
        }

        let tx_data = Transaction {
            from: sender_id.to_string(),
            to: msg.clone(),
            amount: U128::from(amount),
            timestamp: U64::from(env::block_timestamp() / 1_000_000_000),
            nonce: self.nonce,
        };

        // Insert tx_data in LookupMap
        let mut tx_vector = self.transactions.get(&tx_data.from).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(sender_id.as_bytes()),
            })
        });
        tx_vector.push(&tx_data);
        self.transactions.insert(&tx_data.from, &tx_vector);

        // Update storage paid
        let new_storage_paid =
            user_storage_paid - self.bytes_for_ft_on_transfer as u128 * env::STORAGE_PRICE_PER_BYTE;
        self.storage_paid.insert(&sender_id, &new_storage_paid);

        // Increment nonce
        self.nonce = U128::from(u128::from(self.nonce) + 1 as u128);

        let log = format!(
            "Sent {} tokens from {} to {} in direction near->evm",
            amount, sender_id, msg
        );
        env::log_str(&log);
        PromiseOrValue::Value(U128::from(amount_to_return))
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
        let mut this = Self {
            bytes_for_register: 0,
            bytes_for_ft_on_transfer: 0,
            bytes_for_fulfill: 0,
            owner,
            relayer_role: relayer_role.parse().unwrap(),
            token,
            fee_wallet,
            limit_per_send: Balance::from(limit_per_send),
            nonce: U128::from(0),
            fee_numerator,
            transactions: LookupMap::new(StorageKey::Transactions),
            fulfilled: LookupSet::new(StorageKey::Fulfilled),
            storage_paid: LookupMap::new(StorageKey::StoragePaid),
        };
        this.measure_bytes_for_functions();
        this
    }

    // Fulfills transaction from another chain
    #[payable]
    pub fn fulfill(&mut self, transaction: Transaction, signature: String) {
        assert_one_yocto();
        let to_user = AccountId::try_from(transaction.to.clone()).unwrap_or_else(|_| {
            env::panic_str("Not convertible transaction.to field to AccountId type")
        });

        let user_storage_paid = self
            .storage_paid
            .get(&to_user)
            .unwrap_or_else(|| env::panic_str("Not enough storage paid"));
        if user_storage_paid < self.bytes_for_fulfill as u128 * env::STORAGE_PRICE_PER_BYTE {
            env::panic_str("Not enough storage paid");
        }

        // Update storage paid
        let new_storage_paid =
            user_storage_paid - self.bytes_for_fulfill as u128 * env::STORAGE_PRICE_PER_BYTE;
        self.storage_paid.insert(&to_user, &new_storage_paid);

        // Tx reply check
        let tx_hash_bytes = env::keccak256(
            &bincode::serialize(&transaction)
                .unwrap_or_else(|_| env::panic_str("Serializing transaction field is failed")),
        );
        let tx_hash = hex::encode(tx_hash_bytes.clone());
        if self.fulfilled.contains(&tx_hash) {
            env::panic_str("Tx has already been fulfilled");
        }

        // Signature checks
        let sig_recover = env::ecrecover(
            &tx_hash_bytes,
            signature.as_bytes(),
            ECRECOVER_V,
            ECRECOVER_M,
        )
        .unwrap_or_else(|| env::panic_str("Signature recover failed"));
        if sig_recover != self.relayer_role.as_bytes() {
            env::panic_str("Wrong (not relayer role) signature");
        }

        self.fulfilled.insert(&tx_hash);

        let current_fee =
            u128::from(transaction.amount) * self.fee_numerator as u128 / FEE_DENOMINATOR as u128;
        let dispense_amount = u128::from(transaction.amount) - current_fee;

        let log = format!(
            "Dispense {} tokens from {} to {} in direction evm->near",
            dispense_amount, transaction.from, to_user
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
            .then(
                Self::ext(env::current_account_id()) // .with_static_gas(GAS_FOR_RESOLVE_FULFILLED_SIG) should be deleted??? if not GAS_FOR_RESOLVE_FULFILLED_SIG = ???
                    .resolve_fulfill(
                        U128::from(dispense_amount),
                        &tx_hash,
                        &transaction,
                        to_user.clone(),
                    ),
            );

        // If tx hash in set, dispense to user was successful, then transfer FT to fee_wallet
        if current_fee != 0 as u128 && self.fulfilled.contains(&tx_hash) {
            ext_ft_core::ext(self.token.clone())
                .with_attached_deposit(1)
                .ft_transfer(
                    self.fee_wallet.clone(),
                    U128::from(current_fee),
                    Some("Transferring fee".to_string()),
                );
        }
    }

    // Callback for fulfill
    #[private]
    pub fn resolve_fulfill(
        &mut self,
        amount: U128,
        tx_hash: &String,
        tx: &Transaction,
        to_user: AccountId,
    ) -> U128 {
        let amount: Balance = amount.into();

        let revert_amount = match env::promise_result(0) {
            PromiseResult::NotReady => env::abort(),
            // If the promise was successful, get the return value and cast it to a U128.
            PromiseResult::Successful(_) => 0,
            // If the promise wasn't successful, return the original amount.
            PromiseResult::Failed => amount,
        };

        // If promise is failed remove txhash from fulfilled set
        if revert_amount > 0 {
            self.fulfilled.remove(tx_hash);
            // Return back storage paid to user as promise failed -> storage of bridge assist wasn't used
            let user_storage_paid = self.storage_paid.get(&to_user).unwrap();
            let new_storage_paid =
                user_storage_paid + self.bytes_for_fulfill as u128 * env::STORAGE_PRICE_PER_BYTE;
            self.storage_paid.insert(&to_user, &new_storage_paid);
        } else {
            let mut tx_vector = self.transactions.get(&tx.from).unwrap_or_else(|| {
                Vector::new(StorageKey::TransactionsInner {
                    account_id_hash: env::sha256_array(tx.from.as_bytes()),
                })
            });
            tx_vector.push(&tx);
            self.transactions.insert(&tx.from, &tx_vector);
        }

        U128(revert_amount)
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
            from: tmp_account_id.to_string(),
            to: to_addr.clone(),
            amount: U128::from(0u128),
            timestamp: U64::from(0),
            nonce: U128::from(0),
        };
        let mut tx_vector = self.transactions.get(&tx_data.from).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(tmp_account_id.as_bytes()),
            })
        });
        tx_vector.push(&tx_data);
        self.transactions.insert(&tx_data.from, &tx_vector);
        self.bytes_for_ft_on_transfer = env::storage_usage() - initial_storage_usage;
        self.transactions.remove(&tx_data.from);

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
        } else {
            let new_storage_balance = self.storage_paid.get(&user).unwrap() + attached_near;
            self.storage_paid.insert(&user, &new_storage_balance);
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

    pub fn emergency_set_bytes_for_register(&mut self, value: StorageUsage) {
        self.only_owner(env::predecessor_account_id());
        if value == self.bytes_for_register {
            env::panic_str("New value is equal to previous value");
        }
        self.bytes_for_register = value;
    }

    pub fn emergency_set_bytes_for_ft_on_transfer(&mut self, value: StorageUsage) {
        self.only_owner(env::predecessor_account_id());
        if value == self.bytes_for_ft_on_transfer {
            env::panic_str("New value is equal to previous value");
        }
        self.bytes_for_ft_on_transfer = value;
    }

    pub fn emergency_set_bytes_for_fulfill(&mut self, value: StorageUsage) {
        self.only_owner(env::predecessor_account_id());
        if value == self.bytes_for_fulfill {
            env::panic_str("New value is equal to previous value");
        }
        self.bytes_for_fulfill = value;
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

    pub fn get_transactions_by_user(&self, user: String) -> String {
        let txs = self.transactions.get(&user).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(user.as_bytes()),
            })
        });
        let mut result = vec![];
        for i in 0..txs.len() {
            result.push(txs.get(i).unwrap());
        }
        serde_json::to_string(&result).unwrap()
    }

    pub fn is_tx_fulfilled(&self, tx_hash: String) -> bool {
        self.fulfilled.contains(&tx_hash)
    }

    pub fn get_storage_paid_info(&self, user: AccountId) -> (bool, U128, U128, U128, U128) {
        let storage_cost = env::STORAGE_PRICE_PER_BYTE;
        (
            self.storage_paid.contains_key(&user),
            U128::from(self.storage_paid.get(&user).unwrap_or(0 as u128)),
            U128::from(self.bytes_for_register as u128 * storage_cost),
            U128::from(self.bytes_for_ft_on_transfer as u128 * storage_cost),
            U128::from(self.bytes_for_fulfill as u128 * storage_cost),
        )
    }
}
