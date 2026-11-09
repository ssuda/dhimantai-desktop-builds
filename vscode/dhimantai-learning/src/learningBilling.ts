/** Never let a server response open arbitrary URI schemes or another checkout host. */
export function checkoutUri(value: string, apiUrl: string): string {
  const url = new URL(value), api = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.origin !== api.origin || url.username || url.password
      || url.pathname !== '/learning-billing/checkout' || url.search || !url.hash.startsWith('#ticket=')) {
    throw new Error('Checkout returned an unexpected address. Refresh purchases and try again.');
  }
  return url.toString();
}

export function priceLabel(amount: number, currency: string): string {
  // Whole amounts read as ₹2,999, not ₹2,999.00.
  const whole = amount % 100 === 0;
  return new Intl.NumberFormat('en-IN', {style: 'currency', currency,
    ...(whole ? {minimumFractionDigits: 0, maximumFractionDigits: 0} : {})}).format(amount / 100);
}
