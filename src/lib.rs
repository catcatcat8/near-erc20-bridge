use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::Serialize;
use near_sdk::{env, AccountId, Balance, near_bindgen, BorshStorageKey, PromiseOrValue, assert_one_yocto, ext_contract, Promise, PanicOnDefault};
use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{U128, U64};

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

#[derive(BorshDeserialize, BorshSerialize, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Transaction {
  pub from: AccountId,
  pub to: String, 
  pub timestamp: U64,
  pub amount: Balance,
  pub nonce: U128
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
struct BridgeAssist {
  pub owner: AccountId,
  pub token: AccountId,
  pub nonce: U128,
  pub limit_per_send: Balance,
  pub transactions: LookupMap<AccountId, Transaction>,
}

/// Helper structure to for keys of the persistent collections.
#[derive(BorshStorageKey, BorshSerialize)]
pub enum StorageKey {
    Transactions
}

#[near_bindgen]
impl FungibleTokenReceiver for BridgeAssist {
  fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
    // Ensure only the specified FT can be used
    let ft_contract_id = env::predecessor_account_id();
    assert_eq!(env::predecessor_account_id(), self.token, "Only supports the one fungible token contract");

    // make sure that the signer isn't the predecessor. This is so that we're sure
    // this was called via a cross-contract call
    let signer_id = env::signer_account_id();
    assert_ne!(
      ft_contract_id,
      signer_id,
      "Should only be called via cross-contract call"
    );

    //make sure the owner ID is the signer. 
    assert_eq!(
      sender_id,
      signer_id,
      "owner_id should be signer_id"
    );

    let mut amount = Balance::from(amount);
    let mut amountToReturn = Balance::from('0');
    if amount > self.limit_per_send {
      amountToReturn = self.limit_per_send - amount;
      amount = self.limit_per_send;
    }

    // @TODO: CHECK POSSIBILITY NOT TO USE CLONE
    let tx_data = Transaction {
      from: sender_id.clone(),
      to: msg.clone(),
      timestamp: U64::from(env::block_timestamp()),
      amount: amount.clone(),
      nonce: self.nonce.clone()
    }; 
    self.transactions.insert(&sender_id, &tx_data);
    self.nonce = U128::from(u128::from(self.nonce) + 1); // TODO: WHY U128 u128 wtf
    let log = format!("NEAR->EVM bridging {} tokens from {} to {}", amount, sender_id, msg.clone());
    env::log_str(&log);
    PromiseOrValue::Value(U128::from(amountToReturn))
  }
}

#[near_bindgen]
impl BridgeAssist {
  #[init]
  pub fn init(owner: AccountId, token: AccountId, limit_per_send: Balance) -> Self {
    Self {
      owner,
      token,
      nonce: U128::from(0),
      limit_per_send,
      transactions: LookupMap::new(StorageKey::Transactions)
    }
  }

  pub fn fulfill(&self, to: AccountId, amount: U128) -> Promise {
    assert_one_yocto();
    // hash of Transaction, signatures check etc...
    let log = format!("EVM->NEAR bridging {} tokens to {}", u128::from(amount), to);
    env::log_str(&log);
    ext_ft_core::ext(self.token.clone()).with_attached_deposit(1).ft_transfer(to, amount, None) // set true before and add callback (if transfer fails return false) 
  }
}
