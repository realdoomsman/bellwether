import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderAssetId, floatToWire, floorSize, roundPrice } from './format.ts';

test('builder-dex asset id = 100000 + dex index * 10000 + universe index', () => {
  assert.equal(builderAssetId(1, 0), 110_000); // docs example: test:ABC, perp_dex_index 1, index 0
  assert.equal(builderAssetId(1, 9), 110_009); // xyz is perpDexs[1]; xyz:AAPL is universe[9] at time of writing
  assert.equal(builderAssetId(3, 42), 130_042);
  assert.throws(() => builderAssetId(0, 1), RangeError); // index 0 is the default dex, not a builder dex
  assert.throws(() => builderAssetId(1, 10_000), RangeError);
});

test('prices keep <= 5 significant figures and <= 6 - szDecimals decimals', () => {
  assert.equal(roundPrice(341.19 * 1.005, 3), 342.9);
  assert.equal(roundPrice(1234.5678, 2), 1234.6);
  assert.equal(roundPrice(0.123456, 0), 0.12346);
  assert.equal(roundPrice(0.0123456, 3), 0.012);
  assert.equal(roundPrice(30660 * 1.005, 4), 30813);
  assert.equal(roundPrice(123_456.7, 2), 123_457); // integers are always valid
  assert.throws(() => roundPrice(0, 2), RangeError);
});

test('sizes round down to the lot and never exceed the input', () => {
  assert.equal(floorSize((10 * 20) / 341.35, 3), 0.585);
  assert.equal(floorSize(1.0049, 2), 1);
  assert.equal(floorSize(4.35, 2), 4.35); // 4.35 * 100 = 434.99999999999994 in binary
  assert.equal(floorSize(0.0009, 3), 0);
});

test('wire format matches the SDK float_to_wire', () => {
  assert.equal(floatToWire(1670.1), '1670.1');
  assert.equal(floatToWire(0.0147), '0.0147');
  assert.equal(floatToWire(100), '100');
  assert.equal(floatToWire(0), '0');
  assert.equal(floatToWire(-0), '0');
  assert.throws(() => floatToWire(0.000000001), RangeError);
});
