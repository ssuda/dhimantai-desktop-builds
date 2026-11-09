import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkoutUri, priceLabel } from '../src/learningBilling';

test('only HTTPS checkout on the selected service can be opened', () => {
  const api = 'https://api.example.test';
  assert.equal(checkoutUri(api + '/learning-billing/checkout#ticket=opaque', api), api + '/learning-billing/checkout#ticket=opaque');
  for (const url of ['command:workbench.action.openSettings', 'https://evil.test/learning-billing/checkout#ticket=x',
    'http://api.example.test/learning-billing/checkout#ticket=x', api + '/elsewhere#ticket=x',
    'https://user@api.example.test/learning-billing/checkout#ticket=x', api + '/learning-billing/checkout?token=x#ticket=x']) {
    assert.throws(() => checkoutUri(url, api));
  }
});

test('prices are formatted from paise without changing the purchase amount', () => {
  assert.equal(priceLabel(49900, 'INR'), '₹499');
  assert.equal(priceLabel(49950, 'INR'), '₹499.50');
  assert.equal(priceLabel(299900, 'INR'), '₹2,999');
});
