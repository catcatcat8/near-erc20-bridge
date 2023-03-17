import { Worker, NearAccount, NEAR, BN } from "near-workspaces";
import anyTest, { TestFn } from "ava";

const ONE_NEAR = new BN(new BN("10").pow(new BN("24")));
const DELTA = new BN(new BN("10").pow(new BN("22")));
const STORAGE_BYTE_COST = "1.5 mN";

const FEE_NUMERATOR = 8000;
const TOTAL_SUPPLY = "1000000000000000000000000";
const DECIMALS = 18;
const LIMIT_PER_SEND = new BN(50).mul(new BN(10).pow(new BN(DECIMALS)));
const USER_INITIAL_FT_BALANCE = new BN(66).mul(
  new BN(10).pow(new BN(DECIMALS))
);
const RELAYER_ROLE = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

let payForRegister = new BN("0");
let payForFtOnTransfer = new BN("0");
let payForFulfill = new BN("0");

const test = anyTest as TestFn<{
  worker: Worker;
  accounts: Record<string, NearAccount>;
}>;

function panicMessageFromThrowsAsync(error: Error | undefined): string {
  return JSON.parse(error?.message!).result.status.Failure.ActionError.kind
    .FunctionCallError.ExecutionError;
}

async function registerUser(ft: NearAccount, user: NearAccount) {
  await user.call(
    ft,
    "storage_deposit",
    { account_id: user },
    { attachedDeposit: STORAGE_BYTE_COST }
  );
}

async function storageDeposit(
  user: NearAccount,
  bridge: NearAccount,
  amount: BN
) {
  await user.call(bridge, "storage_deposit", {}, { attachedDeposit: amount });
}

test.beforeEach(async (t) => {
  const worker = await Worker.init();

  const owner = worker.rootAccount;
  const user = await owner.createSubAccount("user-account", {
    initialBalance: NEAR.parse("100 N").toJSON(),
  });

  const token = await owner.devDeploy("../res/fungible_token.wasm", {
    initialBalance: NEAR.parse("100 N").toJSON(),
    method: "new",
    args: {
      owner_id: owner.accountId,
      total_supply: TOTAL_SUPPLY,
      metadata: {
        spec: "ft-1.0.0",
        name: "USD Coin",
        symbol: "USDC",
        decimals: DECIMALS,
      },
    },
  });
  const bridge = await owner.devDeploy("../res/near_bridge_assist.wasm", {
    initialBalance: NEAR.parse("100 N").toJSON(),
    method: "init",
    args: {
      owner: owner.accountId,
      relayer_role: RELAYER_ROLE,
      token: token.accountId,
      fee_wallet: owner.accountId,
      limit_per_send: LIMIT_PER_SEND.toString(),
      fee_numerator: FEE_NUMERATOR,
    },
  });
  const wrongToken = await owner.devDeploy("../res/fungible_token.wasm", {
    initialBalance: NEAR.parse("100 N").toJSON(),
    method: "new",
    args: {
      owner_id: owner.accountId,
      total_supply: TOTAL_SUPPLY,
      metadata: {
        spec: "ft-1.0.0",
        name: "USD Coin",
        symbol: "USDC",
        decimals: DECIMALS,
      },
    },
  });
  await registerUser(token, bridge);
  await registerUser(wrongToken, bridge);
  await registerUser(token, user);
  await registerUser(wrongToken, user);
  await owner.call(
    token.accountId,
    "ft_transfer",
    {
      receiver_id: user.accountId,
      amount: USER_INITIAL_FT_BALANCE.toString(),
    },
    { attachedDeposit: "1" }
  );
  await owner.call(
    wrongToken.accountId,
    "ft_transfer",
    {
      receiver_id: user.accountId,
      amount: USER_INITIAL_FT_BALANCE.toString(),
    },
    { attachedDeposit: "1" }
  );

  const storageData: any = await bridge.view("get_storage_paid_info", {
    user: bridge.accountId,
  });
  payForRegister = new BN(storageData[2]);
  payForFtOnTransfer = new BN(storageData[3]);
  payForFulfill = new BN(storageData[4]);

  t.context.worker = worker;
  t.context.accounts = { owner, bridge, token, wrongToken, user };
});

test.afterEach(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log("Failed to stop the Sandbox:", error);
  });
});

test("Constructor", async (t) => {
  const { owner, token, bridge } = t.context.accounts;
  t.is(await bridge.view("get_owner", {}), owner.accountId);
  t.is(await bridge.view("get_relayer_role", {}), RELAYER_ROLE);
  t.is(await bridge.view("get_token", {}), token.accountId);
  t.deepEqual(await bridge.view("get_fee_info", {}), [
    owner.accountId,
    FEE_NUMERATOR,
    10000,
  ]);
  t.is(await bridge.view("get_limit_per_send", {}), LIMIT_PER_SEND.toString());
  t.is(await bridge.view("get_nonce", {}), new BN(0).toString());
  t.is(
    await bridge.view("get_transactions_by_user", { user: owner.accountId }),
    "[]"
  );
});

test("Successful changes fee numerator by admin", async (t) => {
  const { owner, token, bridge, user } = t.context.accounts;
  await owner.call(bridge, "set_fee_numerator", { fee_numerator: 222 });
  t.deepEqual(await bridge.view("get_fee_info", {}), [
    owner.accountId,
    222,
    10000,
  ]);
  const error = await t.throwsAsync(
    user.call(bridge, "set_fee_numerator", { fee_numerator: 1000 })
  );
  t.is(
    panicMessageFromThrowsAsync(error),
    "Smart contract panicked: Only owner function"
  );
});

/*
 -------------
 Storage tests
 -------------
 */

test("Successful first and second storage deposit", async (t) => {
  const { bridge, user } = t.context.accounts;

  await storageDeposit(user, bridge, ONE_NEAR);
  const expectedStoragePaid = ONE_NEAR.sub(payForRegister);
  let actualUserPaid: any = await bridge.view("get_storage_paid_info", {
    user: user.accountId,
  });
  t.true(actualUserPaid[0]);
  t.deepEqual(actualUserPaid[1], expectedStoragePaid.toString());

  await storageDeposit(user, bridge, ONE_NEAR);
  actualUserPaid = await bridge.view("get_storage_paid_info", {
    user: user.accountId,
  });
  t.true(actualUserPaid[0]);
  t.deepEqual(actualUserPaid[1], expectedStoragePaid.add(ONE_NEAR).toString());
});

test("First storage deposit panics if NEAR not enough", async (t) => {
  const { bridge, user } = t.context.accounts;

  const error = await t.throwsAsync(
    user.call(
      bridge,
      "storage_deposit",
      {},
      { attachedDeposit: payForRegister.sub(new BN(1)) }
    )
  );
  t.is(
    panicMessageFromThrowsAsync(error),
    "Smart contract panicked: Not enough NEAR attached"
  );
  await storageDeposit(user, bridge, payForRegister);
  await storageDeposit(user, bridge, new BN(1));
});

test("Bridge balance is not reduced after storageDeposit()", async (t) => {
  const { bridge, user } = t.context.accounts;

  const bridgeBalanceBefore = await (await bridge.balance()).available;
  await storageDeposit(user, bridge, payForRegister);
  t.true(await (await bridge.balance()).available.gt(bridgeBalanceBefore));
  t.true(
    await (await bridge.balance()).available.sub(bridgeBalanceBefore).lt(DELTA)
  ); // profit is small

  const bridgeBalanceBefore2 = await (await bridge.balance()).available;
  await storageDeposit(user, bridge, ONE_NEAR);
  t.true(
    await (await bridge.balance()).available
      .sub(ONE_NEAR)
      .gt(bridgeBalanceBefore2)
  );
  t.true(
    await (await bridge.balance()).available
      .sub(bridgeBalanceBefore2)
      .sub(ONE_NEAR)
      .lt(DELTA)
  );
});

test("Correct storage withdraw", async (t) => {
  const { bridge, user } = t.context.accounts;

  let error = await t.throwsAsync(
    user.call(bridge, "storage_withdraw", {
      amount: new BN(1).toString(),
    })
  );
  t.is(
    panicMessageFromThrowsAsync(error),
    "Smart contract panicked: No storage paid"
  );

  await storageDeposit(user, bridge, ONE_NEAR);

  error = await t.throwsAsync(
    user.call(bridge, "storage_withdraw", {
      amount: ONE_NEAR.sub(payForRegister).add(new BN(1)).toString(),
    })
  );
  t.is(
    panicMessageFromThrowsAsync(error),
    "Smart contract panicked: Amount is more than your storage paid"
  );

  const userBalanceBefore = await (await user.balance()).available;
  const storagePaidBefore = new BN(
    (
      (await bridge.view("get_storage_paid_info", {
        user: user.accountId,
      })) as any
    )[1]
  );
  await user.call(bridge, "storage_withdraw", {
    amount: ONE_NEAR.sub(payForRegister).toString(),
  });
  t.true(
    new BN(
      (
        (await bridge.view("get_storage_paid_info", {
          user: user.accountId,
        })) as any
      )[1]
    ).eq(storagePaidBefore.sub(ONE_NEAR.sub(payForRegister)))
  );

  // balance after ~ balance before + 1 NEAR
  t.true(
    await (await user.balance()).available
      .sub(userBalanceBefore)
      .gt(ONE_NEAR.sub(DELTA))
  );
  t.true(
    await (await user.balance()).available.sub(userBalanceBefore).lt(ONE_NEAR)
  );

  error = await t.throwsAsync(
    user.call(bridge, "storage_withdraw", {
      amount: new BN(1).toString(),
    })
  );
  t.is(
    panicMessageFromThrowsAsync(error),
    "Smart contract panicked: Amount is more than your storage paid"
  );
});

/*
 ----------------------
 Ft_on_transfer() tests
 ----------------------
 */

const TRANSFER_AMOUNT = new BN(10).mul(new BN(10).pow(new BN(18)));
const ETH_ADDR = "0x3Ba6810768c2F4FD3Be2c5508E214E68B514B35f";
const GAS_REQUIRED = new BN(30).mul(new BN(10).pow(new BN(13)));

test("Ft_on_transfer panic", async (t) => {
  const { bridge, user, token, wrongToken } = t.context.accounts;

  let tx = await user.callRaw(
    wrongToken,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );
  t.is(tx.logs[1], "PANIC: Not supported fungible token");

  tx = await token.callRaw(
    bridge,
    "ft_on_transfer",
    {
      sender_id: token.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { gas: GAS_REQUIRED }
  );
  t.is(tx.logs[0], "PANIC: Should only be called via cross-contract call");

  tx = await user.callRaw(
    token,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + "x",
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );
  t.is(
    tx.logs[1],
    "PANIC: 42 hexadecimal characters as ETH address should be specified in msg field"
  );

  tx = await user.callRaw(
    token,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );
  t.is(tx.logs[1], "PANIC: Not storage paid");

  await storageDeposit(user, bridge, payForRegister);
  tx = await user.callRaw(
    token,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );
  t.is(tx.logs[1], "PANIC: Not enough storage paid");
});

test("Successful ft_on_transfer", async (t) => {
  const { bridge, user, token, wrongToken } = t.context.accounts;

  await storageDeposit(user, bridge, payForRegister.add(payForFtOnTransfer));
  const bbUser = (await token.view("ft_balance_of", {
    account_id: user.accountId,
  })) as string;
  const bbBridge = (await token.view("ft_balance_of", {
    account_id: bridge.accountId,
  })) as string;
  const tx = await user.callRaw(
    token,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );

  t.is(
    tx.logs[1],
    `Sent ${TRANSFER_AMOUNT.toString()} tokens from ${
      user.accountId
    } to ${ETH_ADDR} in direction near->evm`
  );

  t.is(
    await token.view("ft_balance_of", { account_id: user.accountId }),
    new BN(bbUser).sub(TRANSFER_AMOUNT).toString()
  );
  t.is(
    await token.view("ft_balance_of", { account_id: bridge.accountId }),
    new BN(bbBridge).add(TRANSFER_AMOUNT).toString()
  );

  const txData = JSON.parse(
    (await bridge.view("get_transactions_by_user", {
      user: user.accountId,
    })) as any
  )[0];

  t.is(txData.from, user.accountId);
  t.is(txData.to, ETH_ADDR);
  t.is(txData.amount, TRANSFER_AMOUNT.toString());
  t.is(txData.nonce, "0");

  t.is(
    (
      (await bridge.view("get_storage_paid_info", {
        user: user.accountId,
      })) as any
    )[1],
    "0"
  );
  t.is(await bridge.view("get_nonce"), "1");

  const tx2 = await user.callRaw(
    token,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );
  t.is(tx2.logs[1], "PANIC: Not enough storage paid");

  await storageDeposit(user, bridge, payForFtOnTransfer);
  const tx3 = await user.callRaw(
    token,
    "ft_transfer_call",
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR,
    },
    { attachedDeposit: "1", gas: GAS_REQUIRED }
  );
  t.is(
    tx3.logs[1],
    `Sent ${TRANSFER_AMOUNT.toString()} tokens from ${
      user.accountId
    } to ${ETH_ADDR} in direction near->evm`
  );
  const txData3 = JSON.parse(
    (await bridge.view("get_transactions_by_user", {
      user: user.accountId,
    })) as any
  )[1];
  t.is(txData3.from, user.accountId);
  t.is(txData3.to, ETH_ADDR);
  t.is(txData3.amount, TRANSFER_AMOUNT.toString());
  t.is(txData3.nonce, "1");
  t.is(
    (
      (await bridge.view("get_storage_paid_info", {
        user: user.accountId,
      })) as any
    )[1],
    "0"
  );
  t.is(await bridge.view("get_nonce"), "2");
});
