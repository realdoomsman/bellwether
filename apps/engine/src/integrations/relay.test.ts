import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, parseAbi, parseEther, type Address } from 'viem';
import { DEFAULT_RELAY_DEPOSIT_CONTRACTS, validateRelayQuote, type RelayQuote } from './relay.ts';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const STRANGER: Address = '0x2222222222222222222222222222222222222222';
const USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
/** Relay's own published ERC-20 router on RHC: listed by Relay's API, but not a deposit target. */
const RELAY_ROUTER: Address = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const AMOUNT = parseEther('0.02');
const ABI = parseAbi(['function depositNative(address depositor, bytes32 id)']);
const ORDER_ID = `0x${'ab'.repeat(32)}` as const;

/** Shape of a live RHC ETH → Arbitrum USDC quote (0.02 ETH ≈ $53.50). */
function quote(patch: { to?: Address; depositor?: Address; usdcOut?: string } = {}): RelayQuote {
  return {
    steps: [
      {
        id: 'deposit',
        kind: 'transaction',
        items: [
          {
            data: {
              from: WALLET,
              to: patch.to ?? DEFAULT_RELAY_DEPOSIT_CONTRACTS[0]!,
              data: encodeFunctionData({ abi: ABI, functionName: 'depositNative', args: [patch.depositor ?? WALLET, ORDER_ID] }),
              value: AMOUNT.toString(),
              chainId: 4663,
            },
          },
        ],
      },
    ],
    details: {
      recipient: WALLET,
      currencyOut: { currency: { chainId: 42161, address: USDC }, amount: patch.usdcOut ?? '53502482' },
      totalImpact: { percent: '-0.53' },
    },
  };
}

const expect = {
  wallet: WALLET,
  amountWei: AMOUNT,
  arbitrumUsdc: USDC,
  maxImpactPct: 0.02,
  minUsdc: 0.02 * 2700 * 0.98,
  depositContracts: DEFAULT_RELAY_DEPOSIT_CONTRACTS,
  chain: { id: 4663, disabled: false, depositEnabled: true },
};

test('a deposit to the pinned Relay depository crediting our wallet passes', () => {
  const { deposit, expectedUsdc } = validateRelayQuote(quote(), expect);
  assert.equal(deposit.to, DEFAULT_RELAY_DEPOSIT_CONTRACTS[0]);
  assert.equal(expectedUsdc, 53.502482);
});

test('Relay quotes are refused when the target, depositor or output fails an independent check', () => {
  const cases: [string, RelayQuote, RegExp][] = [
    ['a Relay-published contract that is not the pinned depository', quote({ to: RELAY_ROUTER }), /not a pinned Relay depository/],
    ['calldata that credits someone else', quote({ depositor: STRANGER }), /deposit credits/],
    ['output below the engine-priced floor despite a small self-reported impact', quote({ usdcOut: '40000000' }), /below the \$52\.92 floor/],
  ];
  for (const [label, q, reason] of cases) assert.throws(() => validateRelayQuote(q, expect), reason, label);
  const garbage = quote();
  garbage.steps[0]!.items[0]!.data.data = '0xdeadbeef';
  assert.throws(() => validateRelayQuote(garbage, expect), /not a Relay depositNative call/);
});
