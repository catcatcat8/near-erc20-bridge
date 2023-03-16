import { Worker, NearAccount, NEAR, BN } from 'near-workspaces'
import anyTest, { TestFn } from 'ava'

const ONE_NEAR = new BN(new BN("10").pow(new BN("24")))
const STORAGE_BYTE_COST = '1.5 mN'

const LIMIT_PER_SEND = 2000
const FEE_NUMERATOR = 8000
const TOTAL_SUPPLY = '1000000000000000000000000'
const RELAYER_ROLE = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp'

let payForRegister = new BN("0")
let payForFtOnTransfer = new BN("0")
let payForFulfill = new BN("0")

const test = anyTest as TestFn<{
  worker: Worker
  accounts: Record<string, NearAccount>
}>

function panicMessageFromThrowsAsync(error: Error | undefined): string {
  return JSON.parse(error?.message!).result.status.Failure.ActionError.kind
    .FunctionCallError.ExecutionError
}

async function registerUser(ft: NearAccount, user: NearAccount) {
  await user.call(
    ft,
    'storage_deposit',
    { account_id: user },
    { attachedDeposit: STORAGE_BYTE_COST },
  )
}

test.beforeEach(async (t) => {
  const worker = await Worker.init()

  const owner = worker.rootAccount
  const user = await owner.createSubAccount('user-account', {
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
        decimals: 18,
      },
    },
  })
  const bridge = await owner.devDeploy('../res/near_bridge_assist.wasm', {
    initialBalance: NEAR.parse('100 N').toJSON(),
    method: 'init',
    args: {
      owner: owner.accountId,
      relayer_role: RELAYER_ROLE,
      token: token.accountId,
      fee_wallet: owner.accountId,
      limit_per_send: LIMIT_PER_SEND,
      fee_numerator: FEE_NUMERATOR,
    },
  })
  await registerUser(token, bridge)

  const storageData: any = await bridge.view('get_storage_paid_info', {user: bridge.accountId})
  payForRegister = new BN(storageData[2])
  payForFtOnTransfer = new BN(storageData[3])
  payForFulfill = new BN(storageData[4])

  t.context.worker = worker
  t.context.accounts = { owner, bridge, token, user }
})

test.afterEach(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log('Failed to stop the Sandbox:', error)
  })
})

test('Constructor', async (t) => {
  const { owner, token, bridge } = t.context.accounts
  t.is(await bridge.view('get_owner', {}), owner.accountId)
  t.is(await bridge.view('get_relayer_role', {}), RELAYER_ROLE)
  t.is(await bridge.view('get_token', {}), token.accountId)
  t.deepEqual(await bridge.view('get_fee_info', {}), [
    owner.accountId,
    FEE_NUMERATOR,
    10000,
  ])
  t.is(await bridge.view('get_limit_per_send', {}), LIMIT_PER_SEND)
  t.is(await bridge.view('get_nonce', {}), '0')
  t.is(
    await bridge.view('get_transactions_by_user', { user: owner.accountId }),
    '[]',
  )
})

test('Successful changes fee numerator by admin', async (t) => {
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

test('Successful storage deposit', async (t) => {
  const { owner, token, bridge, user } = t.context.accounts
  await user.call(bridge, 'storage_deposit', {}, {attachedDeposit: ONE_NEAR})
  const expectedStoragePaid = ONE_NEAR.sub(payForRegister)
  const actualUserPaid = bridge.view("get_storage_paid_info", {user: user.accountId})
  t.true(actualUserPaid[0])
  t.is(actualUserPaid[1], expectedStoragePaid.toString())
})