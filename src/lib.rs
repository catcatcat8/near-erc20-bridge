use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, LookupSet, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    assert_one_yocto, env, near_bindgen, serde_json, AccountId, Balance, BorshStorageKey,
    CryptoHash, Gas, PanicOnDefault, PromiseOrValue, PromiseResult, PublicKey,
};

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
    amount: Balance,
    timestamp: U64,
    nonce: U128,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
struct BridgeAssist {
    owner: AccountId,
    relayer_role: PublicKey,
    token: AccountId,
    fee_wallet: AccountId,
    limit_per_send: Balance,
    nonce: U128,
    fee_numerator: u16,
    transactions: LookupMap<String, Vector<Transaction>>,
    fulfilled: LookupSet<String>,
}

/// Helper structure for keys of the persistent collections
#[derive(BorshStorageKey, BorshSerialize)]
pub enum StorageKey {
    Transactions,
    TransactionsInner { account_id_hash: CryptoHash },
    Fulfilled,
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
            env::panic_str("Not supported fungible token");
        }

        // Require the signer isn't the predecessor. This is so that we're sure
        // this was called via a cross-contract call from FT
        let signer_id = env::signer_account_id();
        if ft_contract_id == signer_id {
            env::panic_str("Should only be called via cross-contract call");
        }
        if sender_id != signer_id {
            env::panic_str("Sender_id is not the signer of tx");
        }

        // Limits check
        let mut amount = Balance::from(amount);
        let mut amount_to_return = Balance::from('0');
        if amount > self.limit_per_send {
            amount_to_return = amount - self.limit_per_send;
            amount = self.limit_per_send;
        }

        // @TODO: CHECK POSSIBILITY NOT TO USE CLONE
        let tx_data = Transaction {
            from: sender_id.to_string(),
            to: msg.clone(),
            amount,
            timestamp: U64::from(env::block_timestamp()),
            nonce: self.nonce,
        };

        let mut tx_vector = self.transactions.get(&tx_data.from).unwrap_or_else(|| {
            Vector::new(StorageKey::TransactionsInner {
                account_id_hash: env::sha256_array(sender_id.as_bytes()),
            })
        });
        tx_vector.push(&tx_data);
        self.transactions.insert(&tx_data.from, &tx_vector);
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
        limit_per_send: Balance,
        fee_numerator: u16,
    ) -> Self {
        if fee_numerator >= FEE_DENOMINATOR {
            env::panic_str("Fee is to high");
        }
        Self {
            owner,
            relayer_role: relayer_role.parse().unwrap(),
            token,
            fee_wallet,
            limit_per_send,
            nonce: U128::from(0),
            fee_numerator,
            transactions: LookupMap::new(StorageKey::Transactions),
            fulfilled: LookupSet::new(StorageKey::Fulfilled),
        }
    }

    // Fulfills transaction from another chain
    #[payable]
    pub fn fulfill(&mut self, transaction: Transaction, signature: String) {
        assert_one_yocto();
        let to_user = AccountId::try_from(transaction.to.clone()).unwrap_or_else(|_| {
            env::panic_str("Not convertible transaction.to field to AccountId type")
        });

        // Tx reply check
        let tx_hash_bytes = env::keccak256(
            &bincode::serialize(&transaction)
                .unwrap_or_else(|_| env::panic_str("Serializing transaction field is failed")),
        );
        let tx_hash = String::from_utf8(tx_hash_bytes.clone())
            .unwrap_or_else(|_| env::panic_str("Not UTF-8 tx hash"));
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

        let current_fee = transaction.amount * self.fee_numerator as u128 / FEE_DENOMINATOR as u128;
        let dispense_amount = transaction.amount - current_fee;

        let log = format!(
            "Dispense {} tokens from {} to {} in direction evm->near",
            dispense_amount, transaction.from, to_user
        );
        env::log_str(&log);

        // Transfer FT to user
        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(1)
            .ft_transfer(
                to_user,
                U128::from(dispense_amount),
                Some("Dispensing from bridge".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_FULFILLED_SIG)
                    .resolve_fulfill(U128::from(dispense_amount), &tx_hash, &transaction),
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
    pub fn resolve_fulfill(&mut self, amount: U128, tx_hash: &String, tx: &Transaction) -> U128 {
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

    // View functions
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

    pub fn get_limit_per_send(&self) -> Balance {
        self.limit_per_send
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
}
