import {
  Worker,
  NearAccount,
  NEAR,
  BN,
  KeyPair,
  KeyPairEd25519,
} from 'near-workspaces'
import anyTest, { TestFn } from 'ava'

const ONE_NEAR = new BN(new BN('10').pow(new BN('24')))
const DELTA = new BN(new BN('10').pow(new BN('22')))
const STORAGE_BYTE_COST = '1.5 mN'

const FEE_NUMERATOR = 800
const TOTAL_SUPPLY = '1000000000000000000000000'
const DECIMALS = 18
const LIMIT_PER_SEND = new BN(50).mul(new BN(10).pow(new BN(DECIMALS)))
const USER_INITIAL_FT_BALANCE = new BN(66).mul(new BN(10).pow(new BN(DECIMALS)))

let payForRegister = new BN('0')
let payForFtOnTransfer = new BN('0')
let payForFulfill = new BN('0')
let payForAddChain = new BN('0')

const test = anyTest as TestFn<{
  worker: Worker
  accounts: Record<string, NearAccount>
}>

function panicMessageFromThrowsAsync(error: Error | undefined): string {
  return JSON.parse(error?.message!).result.status.Failure.ActionError.kind
    .FunctionCallError.ExecutionError
}

async function registerUser(ft: NearAccount, user: NearAccount) {
  await user.callRaw(
    ft,
    'storage_deposit',
    { account_id: user },
    { attachedDeposit: STORAGE_BYTE_COST },
  )
}

async function storageDeposit(
  user: NearAccount,
  bridge: NearAccount,
  amount: BN,
) {
  await user.call(bridge, 'storage_deposit', {}, { attachedDeposit: amount })
}

test.beforeEach(async (t) => {
  const worker = await Worker.init()

  const owner = worker.rootAccount
  const user = await owner.createSubAccount('user-account', {
    initialBalance: NEAR.parse('100 N').toJSON(),
  })
  const keyPairForRelayer = KeyPair.fromString(
    'ed25519:MAvxv8j3mWSN9DQ2KeWKT96D2Yrpd2Yer6en6ZLCXszKt5q55NErhcKvxDb9dfwAXwBjV9paGbSiPfvksyPMmhu',
  )
  const relayer = await owner.createSubAccount('relayer-account', {
    keyPair: keyPairForRelayer,
    initialBalance: NEAR.parse('100 N').toJSON(),
  })

  const token = await owner.devDeploy('../res/fungible_token.wasm', {
    initialBalance: NEAR.parse('100 N').toJSON(),
    method: 'new',
    args: {
      owner_id: owner.accountId,
      total_supply: TOTAL_SUPPLY,
      metadata: {
        spec: 'ft-1.0.0',
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: DECIMALS,
      },
    },
  })
  const bridge = await owner.devDeploy('../res/near_bridge_assist.wasm', {
    initialBalance: NEAR.parse('100 N').toJSON(),
    method: 'init',
    args: {
      owner: owner.accountId,
      relayer_role: (await relayer.getKey())?.getPublicKey().toString(),
      token: token.accountId,
      fee_wallet: owner.accountId,
      limit_per_send: LIMIT_PER_SEND.toString(),
      fee_numerator: FEE_NUMERATOR,
    },
  })
  const wrongToken = await owner.devDeploy('../res/fungible_token.wasm', {
    initialBalance: NEAR.parse('100 N').toJSON(),
    method: 'new',
    args: {
      owner_id: owner.accountId,
      total_supply: TOTAL_SUPPLY,
      metadata: {
        spec: 'ft-1.0.0',
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: DECIMALS,
      },
    },
  })
  await registerUser(token, bridge)
  await registerUser(wrongToken, bridge)
  await registerUser(token, user)
  await registerUser(wrongToken, user)
  await owner.callRaw(
    token.accountId,
    'ft_transfer',
    {
      receiver_id: user.accountId,
      amount: USER_INITIAL_FT_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )
  await owner.callRaw(
    wrongToken.accountId,
    'ft_transfer',
    {
      receiver_id: user.accountId,
      amount: USER_INITIAL_FT_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )

  const storageData: any = await bridge.view('get_storage_paid_info', {
    user: bridge.accountId,
  })
  payForRegister = new BN(storageData[2])
  payForFtOnTransfer = new BN(storageData[3])
  payForFulfill = new BN(storageData[4])
  payForAddChain = new BN(await bridge.view('get_pay_for_add_chain'))

  await owner.callRaw(
    bridge,
    'add_chain',
    {
      chain: 'BSC',
    },
    { attachedDeposit: payForAddChain },
  )

  t.context.worker = worker
  t.context.accounts = { owner, bridge, token, wrongToken, user, relayer }
})

test.afterEach(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log('Failed to stop the Sandbox:', error)
  })
})

/*
 -----------
 Constructor
 -----------
*/

test('Constructor', async (t) => {
  const { owner, token, bridge, relayer } = t.context.accounts
  t.is(await bridge.view('get_owner', {}), owner.accountId)
  t.is(
    await bridge.view('get_relayer_role', {}),
    (await relayer.getKey())?.getPublicKey().toString(),
  )
  t.is(await bridge.view('get_token', {}), token.accountId)
  t.deepEqual(await bridge.view('get_fee_info', {}), [
    owner.accountId,
    FEE_NUMERATOR,
    10000,
  ])
  t.is(await bridge.view('get_limit_per_send', {}), LIMIT_PER_SEND.toString())
  t.is(await bridge.view('get_nonce', {}), new BN(0).toString())
  t.deepEqual(
    await bridge.view('get_transactions_by_user', { user: owner.accountId }),
    [],
  )
})

/*
 -------------
 Storage tests
 -------------
 */

test('Successful first and second storage_deposit()', async (t) => {
  const { bridge, user } = t.context.accounts

  await storageDeposit(user, bridge, ONE_NEAR)
  const expectedStoragePaid = ONE_NEAR.sub(payForRegister)
  let actualUserPaid: any = await bridge.view('get_storage_paid_info', {
    user: user.accountId,
  })
  t.true(actualUserPaid[0])
  t.deepEqual(actualUserPaid[1], expectedStoragePaid.toString())
  t.is(actualUserPaid[5], expectedStoragePaid.toString())

  await storageDeposit(user, bridge, ONE_NEAR)
  actualUserPaid = await bridge.view('get_storage_paid_info', {
    user: user.accountId,
  })
  t.true(actualUserPaid[0])
  t.deepEqual(actualUserPaid[1], expectedStoragePaid.add(ONE_NEAR).toString())
  t.is(actualUserPaid[5], expectedStoragePaid.add(ONE_NEAR).toString())
})

test('First storage_deposit() panics if NEAR not enough', async (t) => {
  const { bridge, user } = t.context.accounts

  const error = await t.throwsAsync(
    user.call(
      bridge,
      'storage_deposit',
      {},
      { attachedDeposit: payForRegister.sub(new BN(1)) },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not enough NEAR attached',
  )
  await storageDeposit(user, bridge, payForRegister)
  await storageDeposit(user, bridge, new BN(1))
  const actualUserPaid: any = await bridge.view('get_storage_paid_info', {
    user: user.accountId,
  })
  t.is(actualUserPaid[5], '1')
})

test('Bridge balance is not reduced after storageDeposit()', async (t) => {
  const { bridge, user } = t.context.accounts

  const bridgeBalanceBefore = await (await bridge.balance()).available
  await storageDeposit(user, bridge, payForRegister)
  t.true(await (await bridge.balance()).available.gt(bridgeBalanceBefore))
  t.true(
    await (await bridge.balance()).available.sub(bridgeBalanceBefore).lt(DELTA),
  ) // profit is small

  const bridgeBalanceBefore2 = await (await bridge.balance()).available
  await storageDeposit(user, bridge, ONE_NEAR)
  t.true(
    await (await bridge.balance()).available
      .sub(ONE_NEAR)
      .gt(bridgeBalanceBefore2),
  )
  t.true(
    await (await bridge.balance()).available
      .sub(bridgeBalanceBefore2)
      .sub(ONE_NEAR)
      .lt(DELTA),
  )
})

test('storage_withdraw() is correct', async (t) => {
  const { bridge, user } = t.context.accounts

  let error = await t.throwsAsync(
    user.call(bridge, 'storage_withdraw', {
      amount: new BN(1).toString(),
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: No storage paid',
  )

  await storageDeposit(user, bridge, ONE_NEAR)

  error = await t.throwsAsync(
    user.call(bridge, 'storage_withdraw', {
      amount: ONE_NEAR.sub(payForRegister).add(new BN(1)).toString(),
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Amount is more than your storage paid',
  )

  const userBalanceBefore = await (await user.balance()).available
  const totalStoragePaidBefore = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )
  const storagePaidBefore = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[1],
  )
  await user.call(bridge, 'storage_withdraw', {
    amount: ONE_NEAR.sub(payForRegister).toString(),
  })
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[1],
    ).eq(storagePaidBefore.sub(ONE_NEAR.sub(payForRegister))),
  )
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore.sub(ONE_NEAR.sub(payForRegister))),
  )

  // balance after ~ balance before + 1 NEAR
  t.true(
    await (await user.balance()).available
      .sub(userBalanceBefore)
      .gt(ONE_NEAR.sub(DELTA)),
  )
  t.true(
    await (await user.balance()).available.sub(userBalanceBefore).lt(ONE_NEAR),
  )

  error = await t.throwsAsync(
    user.call(bridge, 'storage_withdraw', {
      amount: new BN(1).toString(),
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Amount is more than your storage paid',
  )
})

/*
 ----------------------
 Ft_on_transfer() tests
 ----------------------
 */

const TRANSFER_AMOUNT = new BN(10).mul(new BN(10).pow(new BN(18)))
const ETH_ADDR = '0x3Ba6810768c2F4FD3Be2c5508E214E68B514B35f'
const CHAIN = 'BSC'
const GAS_REQUIRED = new BN(80).mul(new BN(10).pow(new BN(12)))

test('ft_on_transfer() expected panic', async (t) => {
  const { bridge, user, token, wrongToken } = t.context.accounts

  const bbBridge = (await token.view('ft_balance_of', {
    account_id: bridge.accountId,
  })) as string
  let tx = await user.callRaw(
    wrongToken,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(tx.logs[1], 'PANIC: Not supported fungible token')

  tx = await token.callRaw(
    bridge,
    'ft_on_transfer',
    {
      sender_id: token.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { gas: GAS_REQUIRED },
  )
  t.is(tx.logs[0], 'PANIC: Should only be called via cross-contract call')

  tx = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: 'x',
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(
    tx.logs[1],
    'PANIC: 42 hexadecimal characters as ETH address should be specified in msg field + destination chain',
  )

  tx = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + 'XXX',
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(tx.logs[1], 'PANIC: Chain is not supported')

  tx = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(tx.logs[1], 'PANIC: Not storage paid')

  await storageDeposit(user, bridge, payForRegister)
  tx = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(tx.logs[1], 'PANIC: Not enough storage paid')

  await storageDeposit(user, bridge, payForFtOnTransfer)
  tx = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: LIMIT_PER_SEND.add(new BN(1)).toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(tx.logs[1], 'PANIC: Amount is over the limit per 1 send')

  const error = await t.throwsAsync(
    user.call(
      token,
      'ft_transfer_call',
      {
        receiver_id: bridge.accountId,
        amount: '0',
        msg: ETH_ADDR + CHAIN,
      },
      { attachedDeposit: '1', gas: GAS_REQUIRED },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: The amount should be a positive number',
  )

  t.is(
    await token.view('ft_balance_of', {
      account_id: bridge.accountId,
    }),
    bbBridge,
  )
})

test('ft_on_transfer() success', async (t) => {
  const { bridge, user, token, wrongToken } = t.context.accounts

  await storageDeposit(user, bridge, payForRegister.add(payForFtOnTransfer))
  const bridgeNativeBalanceBefore = await (await bridge.balance()).available
  const bbUser = (await token.view('ft_balance_of', {
    account_id: user.accountId,
  })) as string
  const bbBridge = (await token.view('ft_balance_of', {
    account_id: bridge.accountId,
  })) as string
  const totalStoragePaidBefore = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )
  const tx = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )

  const bridgeNativeBalanceAfter = await (await bridge.balance()).available
  t.true(
    bridgeNativeBalanceAfter.gt(
      bridgeNativeBalanceBefore.sub(payForFtOnTransfer),
    ),
  )
  t.true(
    bridgeNativeBalanceAfter
      .sub(bridgeNativeBalanceBefore.sub(payForFtOnTransfer))
      .lt(DELTA),
  )
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore.sub(payForFtOnTransfer)),
  )
  t.is(
    tx.logs[1],
    `Sent ${TRANSFER_AMOUNT.toString()} tokens from ${
      user.accountId
    } to ${ETH_ADDR} in direction NEAR->BSC`,
  )

  t.is(
    await token.view('ft_balance_of', { account_id: user.accountId }),
    new BN(bbUser).sub(TRANSFER_AMOUNT).toString(),
  )
  t.is(
    await token.view('ft_balance_of', { account_id: bridge.accountId }),
    new BN(bbBridge).add(TRANSFER_AMOUNT).toString(),
  )

  const txData = ((await bridge.view('get_transactions_by_user', {
    user: user.accountId,
  })) as any)[0]

  t.is(txData.from_user, user.accountId)
  t.is(txData.to_user, ETH_ADDR)
  t.is(txData.amount, TRANSFER_AMOUNT.toString())
  t.is(txData.nonce, '0')
  t.is(txData.from_chain, 'NEAR')
  t.is(txData.to_chain, CHAIN)

  t.is(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[1],
    '0',
  )
  t.is(await bridge.view('get_nonce'), '1')

  const tx2 = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: TRANSFER_AMOUNT.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(tx2.logs[1], 'PANIC: Not enough storage paid')

  await storageDeposit(user, bridge, payForFtOnTransfer)
  const totalStoragePaidBefore3 = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )
  const bbBridge3 = (await token.view('ft_balance_of', {
    account_id: bridge.accountId,
  })) as string
  const tx3 = await user.callRaw(
    token,
    'ft_transfer_call',
    {
      receiver_id: bridge.accountId,
      amount: LIMIT_PER_SEND.toString(),
      msg: ETH_ADDR + CHAIN,
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(
    tx3.logs[1],
    `Sent ${LIMIT_PER_SEND.toString()} tokens from ${
      user.accountId
    } to ${ETH_ADDR} in direction NEAR->BSC`,
  )
  const txData3 = ((await bridge.view('get_transactions_by_user', {
    user: user.accountId,
  })) as any)[1]
  t.is(txData3.from_user, user.accountId)
  t.is(txData3.to_user, ETH_ADDR)
  t.is(txData3.amount, LIMIT_PER_SEND.toString())
  t.is(txData3.nonce, '1')
  t.is(txData3.from_chain, 'NEAR')
  t.is(txData3.to_chain, CHAIN)
  t.is(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[1],
    '0',
  )
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore3.sub(payForFtOnTransfer)),
  )
  t.is(await bridge.view('get_nonce'), '2')
  t.is(
    (await token.view('ft_balance_of', {
      account_id: bridge.accountId,
    })) as string,
    new BN(bbBridge3).add(LIMIT_PER_SEND).toString(),
  )
})

/*
 ----------------
 Fullfill() tests
 ----------------
*/

const NEAR_CHAIN = 'NEAR'

test('fullfill() expected panic', async (t) => {
  const { owner, token, bridge, user, relayer } = t.context.accounts
  await owner.callRaw(
    token,
    'ft_transfer',
    {
      receiver_id: bridge.accountId,
      amount: INITIAL_BRIDGE_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )

  let error = await t.throwsAsync(
    user.call(
      bridge,
      'fulfill',
      {
        transaction: {
          from_user: ETH_ADDR,
          to_user: ETH_ADDR,
          amount: new BN(10).toString(),
          timestamp: new BN(666).toString(),
          from_chain: CHAIN,
          to_chain: NEAR_CHAIN,
          nonce: '0',
        },
        signature: Array.from(new Uint8Array(Buffer.from('asd'))),
      },
      { attachedDeposit: '1' },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not enough gas prepaid, at least 80 Tgas is needed',
  )

  error = await t.throwsAsync(
    user.call(
      bridge,
      'fulfill',
      {
        transaction: {
          from_user: ETH_ADDR,
          to_user: ETH_ADDR,
          amount: new BN(10).toString(),
          timestamp: new BN(666).toString(),
          from_chain: CHAIN,
          to_chain: NEAR_CHAIN,
          nonce: '0',
        },
        signature: Array.from(new Uint8Array(Buffer.from('asd'))),
      },
      { attachedDeposit: '1', gas: GAS_REQUIRED },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not convertible transaction.to field to AccountId type',
  )

  error = await t.throwsAsync(
    user.call(
      bridge,
      'fulfill',
      {
        transaction: {
          from_user: ETH_ADDR,
          to_user: user.accountId,
          amount: new BN(10).toString(),
          timestamp: new BN(666).toString(),
          from_chain: CHAIN,
          to_chain: 'AVAX',
          nonce: '0',
        },
        signature: Array.from(new Uint8Array(Buffer.from('asd'))),
      },
      { attachedDeposit: '1', gas: GAS_REQUIRED },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    "Smart contract panicked: Wrong 'toChain' in tx struct",
  )

  error = await t.throwsAsync(
    user.call(
      bridge,
      'fulfill',
      {
        transaction: {
          from_user: ETH_ADDR,
          to_user: user.accountId,
          amount: new BN(10).toString(),
          timestamp: new BN(666).toString(),
          from_chain: NEAR_CHAIN,
          to_chain: NEAR_CHAIN,
          nonce: '0',
        },
        signature: Array.from(new Uint8Array(Buffer.from('asd'))),
      },
      { attachedDeposit: '1', gas: GAS_REQUIRED },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not supported fromChain in tx struct',
  )

  error = await t.throwsAsync(
    user.call(
      bridge,
      'fulfill',
      {
        transaction: {
          from_user: ETH_ADDR,
          to_user: user.accountId,
          amount: new BN(10).toString(),
          timestamp: new BN(666).toString(),
          from_chain: CHAIN,
          to_chain: NEAR_CHAIN,
          nonce: '0',
        },
        signature: Array.from(new Uint8Array(Buffer.from('asd'))),
      },
      { attachedDeposit: '1', gas: GAS_REQUIRED },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not storage paid',
  )

  await user.call(
    bridge,
    'storage_deposit',
    {},
    { attachedDeposit: payForRegister },
  )
  error = await t.throwsAsync(
    user.call(
      bridge,
      'fulfill',
      {
        transaction: {
          from_user: ETH_ADDR,
          to_user: user.accountId,
          amount: new BN(10).toString(),
          timestamp: new BN(666).toString(),
          from_chain: CHAIN,
          to_chain: NEAR_CHAIN,
          nonce: '0',
        },
        signature: Array.from(new Uint8Array(Buffer.from('asd'))),
      },
      { attachedDeposit: '1', gas: GAS_REQUIRED },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not enough storage paid',
  )
})

test('fullfill() promise ft_transfer to user is failed', async (t) => {
  const { owner, token, bridge, user, relayer } = t.context.accounts
  await owner.callRaw(
    token,
    'ft_transfer',
    {
      receiver_id: bridge.accountId,
      amount: INITIAL_BRIDGE_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )
  await relayer.call(
    bridge,
    'storage_deposit',
    {},
    { attachedDeposit: payForRegister.add(payForFulfill) },
  )

  const tx = {
    from_user: ETH_ADDR,
    to_user: relayer.accountId, // fulfill() will fail cause of relayer not registered token
    amount: new BN(100).toString(),
    timestamp: new BN(666).toString(),
    from_chain: CHAIN,
    to_chain: NEAR_CHAIN,
    nonce: '0',
  }

  const hash_of_tx = (await bridge.view('get_tx_hash', {
    transaction: tx,
  })) as Uint8Array
  const signature = (await relayer.getKey())?.sign(Uint8Array.from(hash_of_tx))

  const userStoragePaidBefore = (await bridge.view('get_storage_paid_info', {
    user: tx.to_user,
  })) as any
  const feeWalletBalanceBefore = await token.view('ft_balance_of', {
    account_id: owner.accountId,
  })
  const totalStoragePaidBefore = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )

  const fulfill_tx = await user.callRaw(
    bridge,
    'fulfill',
    {
      transaction: tx,
      signature: Array.from(signature?.signature as Uint8Array),
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  t.is(
    fulfill_tx.logs[2],
    'ft_transfer promise failed (maybe you should call storage_deposit function on token contract for to_user in tx struct)',
  )

  const hexHash = Array.prototype.map
    .call(hash_of_tx, function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2)
    })
    .join('')

  t.false(await bridge.view('is_tx_fulfilled', { tx_hash: hexHash })) // hash is not fulfilled
  const txContractData = (await bridge.view('get_transactions_by_user', {
    user: tx.from_user,
  })) as any
  t.is(txContractData.length, 0) // transaction is not pushed in the list

  t.is(
    ((await bridge.view('get_storage_paid_info', {
      user: tx.to_user,
    })) as any)[1],
    userStoragePaidBefore[1],
  ) // storage paid is equal previous state
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore),
  ) // total storage paid is equal previous state
  t.is(
    await token.view('ft_balance_of', { account_id: owner.accountId }),
    feeWalletBalanceBefore,
  ) // fee is not dispensed
})

test("fullfill() fails as fee wallet didn't call storage_deposit() on token", async (t) => {
  const { owner, token, bridge, user, relayer } = t.context.accounts
  await owner.callRaw(
    token,
    'ft_transfer',
    {
      receiver_id: bridge.accountId,
      amount: INITIAL_BRIDGE_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )
  await user.call(
    bridge,
    'storage_deposit',
    {},
    { attachedDeposit: payForRegister.add(payForFulfill) },
  )

  const tx = {
    from_user: ETH_ADDR,
    to_user: user.accountId,
    amount: new BN(100).toString(),
    timestamp: new BN(666).toString(),
    from_chain: CHAIN,
    to_chain: NEAR_CHAIN,
    nonce: '0',
  }

  const hash_of_tx = (await bridge.view('get_tx_hash', {
    transaction: tx,
  })) as Uint8Array
  const signature = (await relayer.getKey())?.sign(Uint8Array.from(hash_of_tx))

  const userStoragePaidBefore = (await bridge.view('get_storage_paid_info', {
    user: tx.to_user,
  })) as any
  const feeWalletBalanceBefore = await token.view('ft_balance_of', {
    account_id: owner.accountId,
  })
  const toUserBalanceBefore = await token.view('ft_balance_of', {
    account_id: user.accountId,
  })
  const totalStoragePaidBefore = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )

  await owner.call(bridge, 'set_fee_wallet', { fee_wallet: relayer.accountId }) // fulfill() will fail cause of relayer didn't call storage_deposit() on token

  const fulfill_tx = await user.callRaw(
    bridge,
    'fulfill',
    {
      transaction: tx,
      signature: Array.from(signature?.signature as Uint8Array),
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )
  console.log(fulfill_tx.logs)

  t.is(
    fulfill_tx.logs[1],
    "fee wallet didn't storage deposit to token (you can call storage_deposit function on token contract for fee_wallet)",
  )

  const hexHash = Array.prototype.map
    .call(hash_of_tx, function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2)
    })
    .join('')

  t.false(await bridge.view('is_tx_fulfilled', { tx_hash: hexHash })) // hash is not fulfilled
  const txContractData = (await bridge.view('get_transactions_by_user', {
    user: tx.from_user,
  })) as any
  t.is(txContractData.length, 0) // transaction is not pushed in the list

  t.is(
    ((await bridge.view('get_storage_paid_info', {
      user: tx.to_user,
    })) as any)[1],
    userStoragePaidBefore[1],
  ) // storage paid is equal previous state
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore),
  ) // total storage paid is equal previous state
  t.is(
    await token.view('ft_balance_of', { account_id: owner.accountId }),
    feeWalletBalanceBefore,
  ) // fee is not dispensed
  t.is(
    await token.view('ft_balance_of', { account_id: user.accountId }),
    toUserBalanceBefore,
  ) // tokens are not dispensed
})

test('fulfill() success', async (t) => {
  const { owner, token, bridge, user, relayer } = t.context.accounts
  await owner.callRaw(
    token,
    'ft_transfer',
    {
      receiver_id: bridge.accountId,
      amount: INITIAL_BRIDGE_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )

  // FULFILL WITHOUT FEE DISPENSE
  await user.call(
    bridge,
    'storage_deposit',
    {},
    { attachedDeposit: payForFulfill.add(payForRegister) },
  )
  const tx = {
    from_user: ETH_ADDR,
    to_user: user.accountId,
    amount: new BN(10).toString(),
    timestamp: new BN(666).toString(),
    from_chain: CHAIN,
    to_chain: NEAR_CHAIN,
    nonce: '0',
  }

  const hash_of_tx = (await bridge.view('get_tx_hash', {
    transaction: tx,
  })) as Uint8Array
  const signature = (await relayer.getKey())?.sign(Uint8Array.from(hash_of_tx))

  const userBBDispense = await token.view('ft_balance_of', {
    account_id: tx.to_user,
  })
  const feeWalletBBDispense = await token.view('ft_balance_of', {
    account_id: owner.accountId,
  })
  const totalStoragePaidBefore = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )

  await user.call(
    bridge,
    'fulfill',
    {
      transaction: tx,
      signature: Array.from(signature?.signature as Uint8Array),
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )

  const hexHash = Array.prototype.map
    .call(hash_of_tx, function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2)
    })
    .join('')

  t.true(await bridge.view('is_tx_fulfilled', { tx_hash: hexHash }))
  const txContractData1 = ((await bridge.view('get_transactions_by_user', {
    user: tx.from_user,
  })) as any)[0]
  t.is(txContractData1.from_user, tx.from_user)
  t.is(txContractData1.to_user, tx.to_user)
  t.is(txContractData1.amount, tx.amount)
  t.is(txContractData1.timestamp, tx.timestamp)
  t.is(txContractData1.from_chain, tx.from_chain)
  t.is(txContractData1.to_chain, tx.to_chain)
  t.is(txContractData1.nonce, tx.nonce)

  t.is(
    await token.view('ft_balance_of', { account_id: tx.to_user }),
    new BN(userBBDispense as any).add(new BN(tx.amount)).toString(),
  )
  t.is(
    await token.view('ft_balance_of', { account_id: owner.accountId }),
    feeWalletBBDispense,
  )
  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore.sub(payForFulfill)),
  ) // total storage paid decreased

  // FULFILL WITH FEE DISPENSE
  const totalAmount = new BN(100)
  await user.call(
    bridge,
    'storage_deposit',
    {},
    { attachedDeposit: payForFulfill },
  )
  const tx2 = {
    from_user: ETH_ADDR,
    to_user: user.accountId,
    amount: totalAmount.toString(),
    timestamp: new BN(666).toString(),
    from_chain: CHAIN,
    to_chain: NEAR_CHAIN,
    nonce: '0',
  }

  const hash_of_tx2 = (await bridge.view('get_tx_hash', {
    transaction: tx2,
  })) as Uint8Array
  const signature2 = (await relayer.getKey())?.sign(
    Uint8Array.from(hash_of_tx2),
  )

  const userBalanceBeforeDispense = await token.view('ft_balance_of', {
    account_id: tx2.to_user,
  })
  const feeWalletBalanceBeforeDispense = await token.view('ft_balance_of', {
    account_id: owner.accountId,
  })
  const totalStoragePaidBefore2 = new BN(
    ((await bridge.view('get_storage_paid_info', {
      user: user.accountId,
    })) as any)[5],
  )

  await user.call(
    bridge,
    'fulfill',
    {
      transaction: tx2,
      signature: Array.from(signature2?.signature as Uint8Array),
    },
    { attachedDeposit: '1', gas: GAS_REQUIRED },
  )

  const hexHash2 = Array.prototype.map
    .call(hash_of_tx2, function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2)
    })
    .join('')

  t.true(await bridge.view('is_tx_fulfilled', { tx_hash: hexHash2 }))
  const txContractData2 = ((await bridge.view('get_transactions_by_user', {
    user: tx.from_user,
  })) as any)[1]
  t.is(txContractData2.from_user, tx2.from_user)
  t.is(txContractData2.to_user, tx2.to_user)
  t.is(txContractData2.amount, tx2.amount)
  t.is(txContractData2.timestamp, tx2.timestamp)
  t.is(txContractData2.from_chain, tx2.from_chain)
  t.is(txContractData2.to_chain, tx2.to_chain)
  t.is(txContractData2.nonce, tx2.nonce)

  t.true(
    new BN(
      ((await bridge.view('get_storage_paid_info', {
        user: user.accountId,
      })) as any)[5],
    ).eq(totalStoragePaidBefore2.sub(payForFulfill)),
  ) // total storage paid decreased

  const exactTxContractData = (await bridge.view('get_transaction_by_user', {
    user: tx.from_user,
    index: '1',
  })) as any
  t.is(exactTxContractData.from_user, tx2.from_user)
  t.is(exactTxContractData.to_user, tx2.to_user)
  t.is(exactTxContractData.amount, tx2.amount)
  t.is(exactTxContractData.timestamp, tx2.timestamp)
  t.is(exactTxContractData.from_chain, tx2.from_chain)
  t.is(exactTxContractData.to_chain, tx2.to_chain)
  t.is(exactTxContractData.nonce, tx2.nonce)

  const error = await t.throwsAsync(
    user.call(bridge, 'get_transaction_by_user', {
      user: tx.from_user,
      index: '2',
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Index out of range',
  )

  const fee = new BN(tx2.amount).mul(new BN(FEE_NUMERATOR)).div(new BN(10000))
  t.is(
    await token.view('ft_balance_of', { account_id: tx2.to_user }),
    new BN(userBalanceBeforeDispense as any)
      .add(new BN(tx2.amount).sub(fee))
      .toString(),
  )
  console.log(
    await token.view('ft_balance_of', { account_id: owner.accountId }),
  )

  t.is(
    await token.view('ft_balance_of', { account_id: owner.accountId }),
    new BN(feeWalletBalanceBeforeDispense as any).add(fee).toString(),
  )

  t.is(
    await bridge.view('get_transactions_amount_by_user', {
      user: tx.from_user,
    }),
    '2',
  )
})

/*
 ------------------------------
 Administrative functions tests
 ------------------------------
*/

test('set_fee_numerator() is correct', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await owner.call(bridge, 'set_fee_numerator', { fee_numerator: 222 })
  t.deepEqual(await bridge.view('get_fee_info', {}), [
    owner.accountId,
    222,
    10000,
  ])
  const error = await t.throwsAsync(
    user.call(bridge, 'set_fee_numerator', { fee_numerator: 1000 }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )
})

test('transfer_ownership() is correct', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await owner.call(bridge, 'transfer_ownership', { owner: user.accountId })
  t.is(await bridge.view('get_owner', {}), user.accountId)
  let error = await t.throwsAsync(
    owner.call(bridge, 'transfer_ownership', { owner: user.accountId }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )
  error = await t.throwsAsync(
    user.call(bridge, 'transfer_ownership', { owner: user.accountId }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Current owner is equal to new owner',
  )
})

test('set_relayer_role() is correct', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await owner.call(bridge, 'set_relayer_role', {
    relayer: 'ed25519:ifRNRsDd85kNtGj4WRUm17vpqmymwswn8QzCwdJVnBT',
  })
  t.is(
    await bridge.view('get_relayer_role', {}),
    'ed25519:ifRNRsDd85kNtGj4WRUm17vpqmymwswn8QzCwdJVnBT',
  )
  let error = await t.throwsAsync(
    user.call(bridge, 'set_relayer_role', {
      relayer: 'ed25519:DTRVwm7mmqCxfTZTFwi2kgp5vuYB3aiaB67vqcLXCpmh',
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )
  error = await t.throwsAsync(
    owner.call(bridge, 'set_relayer_role', { relayer: 'abc' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Not convertible to PublicKey type',
  )
  error = await t.throwsAsync(
    owner.call(bridge, 'set_relayer_role', {
      relayer:
        'secp256k1:qMoRgcoXai4mBPsdbHi1wfyxF9TdbPCF4qSDQTRP3TfescSRoUdSx6nmeQoN3aiwGzwMyGXAb1gUjBTv5AY8DXj',
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: The only supported curve type for relayer role is ED25519',
  )
  error = await t.throwsAsync(
    owner.call(bridge, 'set_relayer_role', {
      relayer: 'ed25519:ifRNRsDd85kNtGj4WRUm17vpqmymwswn8QzCwdJVnBT',
    }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Current relayer is equal to new relayer',
  )
})

test('set_limit_per_send is correct()', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await owner.call(bridge, 'set_limit_per_send', { limit_per_send: '666' })
  t.is(await bridge.view('get_limit_per_send', {}), '666')
  let error = await t.throwsAsync(
    user.call(bridge, 'set_limit_per_send', { limit_per_send: '500' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )
  error = await t.throwsAsync(
    owner.call(bridge, 'set_limit_per_send', { limit_per_send: '666' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Current limit is equal to new limit',
  )
})

const INITIAL_BRIDGE_BALANCE = new BN(10000).mul(
  new BN(10).pow(new BN(DECIMALS)),
)

test('withdraw() is correct', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await owner.callRaw(
    token,
    'ft_transfer',
    {
      receiver_id: bridge.accountId,
      amount: INITIAL_BRIDGE_BALANCE.toString(),
    },
    { attachedDeposit: '1' },
  )

  const bridgeBalanceBefore = (await token.view('ft_balance_of', {
    account_id: bridge.accountId,
  })) as string
  const ownerBalanceBefore = (await token.view('ft_balance_of', {
    account_id: owner.accountId,
  })) as string
  await owner.call(
    bridge,
    'withdraw',
    { amount: '800' },
    { attachedDeposit: '1' },
  )
  t.is(
    (await token.view('ft_balance_of', {
      account_id: bridge.accountId,
    })) as string,
    new BN(bridgeBalanceBefore).sub(new BN(800)).toString(),
  )
  t.is(
    (await token.view('ft_balance_of', {
      account_id: owner.accountId,
    })) as string,
    new BN(ownerBalanceBefore).add(new BN(800)).toString(),
  )

  const error = await t.throwsAsync(
    user.call(bridge, 'withdraw', { amount: '800' }, { attachedDeposit: '1' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )
})

test('add_chain()/remove_chain() is correct', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  t.true(await bridge.view('is_available_chain', { chain: 'BSC' }))
  t.false(await bridge.view('is_available_chain', { chain: 'AVAX' }))
  await owner.call(
    bridge,
    'add_chain',
    { chain: 'AVAX' },
    { attachedDeposit: payForAddChain },
  )
  t.true(await bridge.view('is_available_chain', { chain: 'AVAX' }))

  let supportedChains = await bridge.view('supported_chain_list')
  t.deepEqual(supportedChains, ['BSC', 'AVAX'])

  let error = await t.throwsAsync(
    owner.call(bridge, 'add_chain', { chain: 'BSC' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Chain is already in the list',
  )

  error = await t.throwsAsync(
    owner.call(bridge, 'remove_chain', { chain: 'XXX' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Chain is not in the list yet',
  )

  const userNativeBalanceBefore = await (await owner.balance()).available
  await owner.call(bridge, 'remove_chain', { chain: 'AVAX' })
  t.false(await bridge.view('is_available_chain', { chain: 'AVAX' }))
  supportedChains = await bridge.view('supported_chain_list')
  t.deepEqual(supportedChains, ['BSC'])
  t.true(await (await owner.balance()).available.gt(userNativeBalanceBefore))

  error = await t.throwsAsync(
    user.call(bridge, 'remove_chain', { chain: 'BSC' }),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )

  error = await t.throwsAsync(user.call(bridge, 'add_chain', { chain: 'AVAX' }))
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Only owner function',
  )
})

test('withdraw_native_fee() is correct', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await user.call(
    bridge,
    'storage_deposit',
    {},
    { attachedDeposit: NEAR.parse('50 N').toJSON() },
  )
  let error = await t.throwsAsync(
    owner.call(
      bridge,
      'withdraw_native_fee',
      { amount: NEAR.parse('110 N').toJSON() },
      { attachedDeposit: '1' },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Left contract balance is less than users total storage paid',
  )
  error = await t.throwsAsync(
    owner.call(
      bridge,
      'withdraw_native_fee',
      { amount: NEAR.parse('1000 N').toJSON() },
      { attachedDeposit: '1' },
    ),
  )
  t.is(
    panicMessageFromThrowsAsync(error),
    'Smart contract panicked: Amount is more than contract balance',
  )
  const ownerBalanceBefore = await owner.availableBalance()
  await owner.call(
    bridge,
    'withdraw_native_fee',
    { amount: NEAR.parse('50 N').toJSON() },
    { attachedDeposit: '1' },
  )
  const ownerBalanceAfter = await owner.availableBalance()
  t.true(
    ownerBalanceBefore
      .add(new BN(NEAR.parse('50 N').toJSON()))
      .sub(ownerBalanceAfter)
      .lt(DELTA),
  )
})
